/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM: AST-Based Gas Metering
 *
 * Transforms contract source code by injecting __gas(1) calls at
 * control flow points. This enables deterministic gas metering
 * without modifying V8 internals.
 *
 * Uses acorn to parse, modifies the AST in place, then regenerates
 * source via astring. This avoids fragile string offset splicing.
 ********************************************************************/
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { generate } = require('astring');

// The contract language version: a FROZEN consensus choice, not an acorn
// default. Every parse in the VM (metering transform, reserved-identifier
// scan, deploy-time validation and the lint scans in syntax.js) pins to this
// version. V8 on the pinned Node runtime accepts a superset of ES2020, so
// everything acorn accepts here parses identically at execution time; the
// only effect of the gap is that post-2020 syntax is rejected at DEPLOY with
// a parse error (a DX limitation, never a consensus divergence). Bumping
// this is a deliberate protocol migration: the metering transform must be
// re-verified against every AST node type the new version introduces
// (e.g. class static blocks), and contracts deployed before the bump must
// keep validating. Do not change it casually.
const CONTRACT_ECMA_VERSION = 2020;

// AST node for: __gas(1)
function gasCallStatement() {
    return {
        type: 'ExpressionStatement',
        expression: gasCallExpr()
    };
}

// AST node for: __gas(1) as an expression (for sequence expressions)
function gasCallExpr() {
    return {
        type: 'CallExpression',
        callee: { type: 'Identifier', name: '__gas' },
        arguments: [{ type: 'Literal', value: 1 }],
        optional: false
    };
}

// Wrap an expression as: (__gas(1), expr)
function wrapWithGas(expr) {
    return {
        type: 'SequenceExpression',
        expressions: [gasCallExpr(), expr]
    };
}

// AST node for a bare call statement:  __name()
function callStatement(name) {
    return {
        type: 'ExpressionStatement',
        expression: { type: 'CallExpression',
            callee: { type: 'Identifier', name: name }, arguments: [], optional: false }
    };
}

// Wrap a function node's (block) body with the deterministic call-depth guard:
//     __depth_enter(); try { <original body> } finally { __depth_exit(); }
// The enter hook throws (and poisons execution) when the fixed depth limit is
// reached; the finally guarantees the counter is decremented on every normal or
// exceptional return so sibling (non-nested) calls do not accumulate depth.
// Any leading directive-prologue statements (e.g. "use strict") are lifted
// before the guard so they keep directive-prologue position in the output,
// matching the same pattern as insertGasAfterDirectives.
function wrapDepthGuard(node) {
    if (!node.body || node.body.type !== 'BlockStatement') return;
    const body = node.body.body;
    const offset = directivePrologueLength(body);
    const directives = body.slice(0, offset);
    const rest = body.slice(offset);
    const tryStmt = {
        type: 'TryStatement',
        block: { type: 'BlockStatement', body: rest },
        handler: null,
        finalizer: { type: 'BlockStatement', body: [callStatement('__depth_exit')] }
    };
    node.body.body = directives.concat([callStatement('__depth_enter'), tryStmt]);
}

// Count the number of directive prologue statements at the start of a body
function directivePrologueLength(body) {
    let count = 0;
    for (const stmt of body) {
        if (stmt.type === 'ExpressionStatement' &&
            stmt.expression.type === 'Literal' &&
            typeof stmt.expression.value === 'string') {
            count++;
        } else {
            break;
        }
    }
    return count;
}

// Insert __gas(1) into a function/block body after any directive prologue
function insertGasAfterDirectives(body) {
    const offset = directivePrologueLength(body);
    body.splice(offset, 0, gasCallStatement());
}

// Ensure a node has a block body (wrap single-statement bodies)
function ensureBlock(node, prop) {
    if (node[prop] && node[prop].type !== 'BlockStatement') {
        node[prop] = {
            type: 'BlockStatement',
            body: [node[prop]]
        };
    }
}

// Get the depth of nested BinaryExpression nodes (left-leaning)
function binaryDepth(node) {
    let depth = 0;
    let current = node;
    while (current.type === 'BinaryExpression') {
        depth++;
        current = current.left;
    }
    return depth;
}

// Harness-injected helpers (src/index.js) that meter syntax-level allocators.
// The pass below rewrites operators/syntax into calls to these; they must never
// be wrapped as ordinary call sites, and contract source may not reference them.
const ALLOC_HELPERS = ['__concat', '__setconcat', '__setconcatL', '__tmpl', '__tmpltag', '__tmpltagm', '__arrspread', '__objspread', '__objspreadmeter'];
// Deterministic call-depth metering helpers (src/index.js harness). Phase 4 below
// wraps every contract function body in __depth_enter()/finally __depth_exit() so
// intra-contract recursion is bounded by a fixed, platform-independent depth (not
// by V8's architecture-dependent native stack limit). Reserved like __gas: a
// contract may not define or reference them.
const DEPTH_HELPERS = ['__depth_enter', '__depth_exit'];
const RESERVED_IDENTIFIERS = ['__gas'].concat(ALLOC_HELPERS).concat(DEPTH_HELPERS);
const HELPER_SET = new Set(ALLOC_HELPERS);

// Small AST builders for the allocator rewrite.
function _ident(name) { return { type: 'Identifier', name: name }; }
function _lit(value)  { return { type: 'Literal', value: value }; }
function _arr(elements) { return { type: 'ArrayExpression', elements: elements }; }
function _call(name, args) {
    return { type: 'CallExpression', callee: _ident(name), arguments: args, optional: false };
}
function _clone(node) { return JSON.parse(JSON.stringify(node)); }
function _void0() { return { type: 'UnaryExpression', operator: 'void', prefix: true, argument: _lit(0) }; }
// A zero-arg arrow that returns `expr` unevaluated: () => expr. Used by the
// spec-correct obj[k] += rhs rewrite to DEFER the rhs so the helper can read
// obj[k] first. An arrow (not a function) keeps `this`/`arguments`/`new.target`
// lexical, so deferring never changes what the rhs would compute inline.
function _arrowThunk(expr) {
    return { type: 'ArrowFunctionExpression', id: null, params: [],
        body: expr, async: false, generator: false, expression: true };
}
// The property key of a member expression, as an expression evaluated once:
// the raw key for computed `o[k]`, or a string literal for `o.k` / `o['k']`.
function _memberKey(member) {
    return member.computed ? member.property
        : (member.property.type === 'Identifier' ? _lit(member.property.name) : _lit(member.property.value));
}

// The rest-destructuring kind of a BINDING PATTERN, or null when the pattern carries
// no TOP-LEVEL rest. Only a rest that sits directly in the pattern being destructured
// has an addressable source expression to wrap; a rest nested one level deeper
// (`var {a: {...c}} = o`) reads an intermediate value with no expression to meter, and
// is rejected at deploy instead (lint-core findBannedRest).
function _restKind(pat) {
    if (!pat) return null;
    if (pat.type === 'ObjectPattern')
        return (pat.properties || []).some(function (p) { return p.type === 'RestElement'; }) ? 'obj' : null;
    if (pat.type === 'ArrayPattern')
        return (pat.elements || []).some(function (e) { return e && e.type === 'RestElement'; }) ? 'arr' : null;
    return null;
}

// Wrap the SOURCE expression of a rest destructure in the size-charged helper that
// matches the copy the pattern is about to perform. Returns src unchanged when the
// pattern carries no top-level rest.
//   ObjectPattern: __objspreadmeter(src) charges by own-key count and returns src
//     verbatim, so the native own-key copy the rest performs is billed without
//     touching evaluation order, getters, or the null/undefined TypeError.
//   ArrayPattern:  __arrspread([['s', src]]) materialises the iterable ONCE through
//     the already-charged helper and hands the pattern a plain array. Sound only
//     because a rest element drains the iterator anyway; a rest-less ArrayPattern is
//     left alone so a lazy or infinite iterator is never over-drained.
function _meterRestSource(pat, src) {
    const kind = _restKind(pat);
    if (kind === 'obj') return _call('__objspreadmeter', [src]);
    if (kind === 'arr') return _call('__arrspread', [_arr([_arr([_lit('s'), src])])]);
    return src;
}

/**
 * Rewrite the syntax-level allocators (string +/+=, template literals, tagged and
 * untagged, array and object spread, gated call/new argument spread, and gated
 * destructuring-rest sources) into calls to the harness metering helpers.
 * Post-order so nested forms (a + b + c) are converted leaf-up. Mutates the AST in
 * place.
 *
 * Arrays with holes mixed with spread are now metered (holes ride as ['h']
 * segments that copy nothing); object spread alongside accessor/method properties
 * keeps its literal verbatim but wraps each spread source in __objspreadmeter so
 * the copy is charged without altering getter/method semantics. Call/new/method
 * argument spread (f(...x), new C(...x), arr.push(...x)) is size-metered at/after
 * the flag day (meterCallSpread): the argument list is rebuilt through the existing
 * __arrspread helper, which charges O(n) by element count. The "bounded by V8's
 * argument-count limit" reasoning held for one oversized call but NOT for a loop of
 * bounded calls, which copied millions of elements for a flat __gas(1) each.
 *
 * Destructuring REST patterns (`var [x, ...c] = a`, `var {k, ...c} = o`) are the same
 * failure mode one dispatch away: a rest is an ArrayPattern/ObjectPattern carrying a
 * RestElement, NOT an ArrayExpression/ObjectExpression carrying a SpreadElement, so
 * every branch above missed it and the O(n) native copy ran for a flat __gas(1) per
 * iteration. At/after the flag day (meterRestPattern) the SOURCE expression of a
 * top-level rest destructure is wrapped in the matching size-charged helper. Rest
 * positions with no addressable source (parameter lists, rest nested inside another
 * pattern, catch-clause rest, for-of/for-in heads) cannot be reached by wrapping and
 * are rejected at deploy on the same flag day instead (lint-core findBannedRest).
 */
function transformAllocators(ast, specEvalOrder, meterCallSpread, meterRestPattern) {
    // An untagged template literal is rewritten to __tmpl(...). A TAGGED template's
    // quasi must NOT be (the tag receives the raw template strings object); we
    // collect those quasis up front, skip converting them here, and instead rewrite
    // the whole TaggedTemplateExpression (below) into a metered helper that rebuilds
    // the strings object and invokes the tag with the correct `this`.
    const taggedQuasis = new WeakSet();
    walk.simple(ast, { TaggedTemplateExpression: function (n) { taggedQuasis.add(n.quasi); } });

    function convert(node) {
        // string concatenation: a + b
        if (node.type === 'BinaryExpression' && node.operator === '+') {
            return _call('__concat', [node.left, node.right]);
        }
        // compound assign: lhs += rhs
        if (node.type === 'AssignmentExpression' && node.operator === '+=') {
            // bare identifier: re-reading the lhs is side-effect-free, so charge
            // in place via  id = __concat(id, rhs).
            if (node.left.type === 'Identifier') {
                return {
                    type: 'AssignmentExpression', operator: '=', left: node.left,
                    right: _call('__concat', [_clone(node.left), node.right])
                };
            }
            // member lhs (computed o[k] or complex a.b.c): evaluate the object and
            // key EXACTLY ONCE here, then let the helper do read/charge/write.
            // Re-reading the lhs in place could double-fire getters / re-evaluate k.
            //
            // L-3 consensus gate. Pre-gate: __setconcat(obj, key, rhs) evaluates rhs
            // as an ordinary argument (BEFORE the helper reads obj[key]), so a rhs
            // that mutates obj[key] diverges from the spec, which reads the old value
            // FIRST. Post-gate: __setconcatL(obj, key, () => rhs) passes rhs as a
            // deferred thunk so the helper reads obj[key] before evaluating rhs,
            // matching spec order. Gated because flipping the order changes results
            // for that (rare) pattern; the flag is threaded from the block time in
            // index.js (isMeteringEvalOrderActive), mirroring the H-5 state-key gate.
            if (node.left.type === 'MemberExpression') {
                return specEvalOrder
                    ? _call('__setconcatL', [node.left.object, _memberKey(node.left), _arrowThunk(node.right)])
                    : _call('__setconcat', [node.left.object, _memberKey(node.left), node.right]);
            }
        }
        // tagged template: tag`q0${e0}q1...`  ->  __tmpltag[m](tag/obj[,key], cooked, raw, [e0,...])
        // The quasi was skipped above (still raw); its expressions were already
        // recursed (metered). Rebuild cooked/raw as literal arrays (cooked may be
        // null for an invalid escape in a tagged template -> void 0 == undefined).
        if (node.type === 'TaggedTemplateExpression') {
            const tl = node.quasi;
            const cooked = tl.quasis.map(function (q) {
                return q.value.cooked == null ? _void0() : _lit(q.value.cooked);
            });
            const raw = tl.quasis.map(function (q) { return _lit(q.value.raw); });
            const exprs = _arr(tl.expressions);
            // member tag (String.raw`...`, obj.m`...`, obj[k]`...`): this = object.
            if (node.tag.type === 'MemberExpression') {
                return _call('__tmpltagm',
                    [node.tag.object, _memberKey(node.tag), _arr(cooked), _arr(raw), exprs]);
            }
            // plain tag (tag`...`, (0,f)`...`, getTag()`...`): this = undefined.
            return _call('__tmpltag', [node.tag, _arr(cooked), _arr(raw), exprs]);
        }
        // template literal: `q0${e0}q1...`  ->  __tmpl([q0, e0, q1, ...])
        if (node.type === 'TemplateLiteral' && !taggedQuasis.has(node)) {
            const parts = [];
            for (let i = 0; i < node.quasis.length; i++) {
                parts.push(_lit(node.quasis[i].value.cooked));
                if (i < node.expressions.length) parts.push(node.expressions[i]);
            }
            return _call('__tmpl', [_arr(parts)]);
        }
        // array spread: [a, ...x]  ->  __arrspread([['e',a], ['s',x]])
        // Arrays that mix holes with spread are rewritten too: a hole becomes an
        // ['h'] segment so __arrspread can recreate the sparse slot without copying
        // (and without charging gas, since a hole moves no data), while spread
        // sources are still charged O(n) by element count. Previously such arrays
        // were returned unmetered, letting [,...x] perform a free native O(n) copy.
        if (node.type === 'ArrayExpression' &&
            node.elements.some(function (e) { return e && e.type === 'SpreadElement'; })) {
            const segs = node.elements.map(function (e) {
                if (e === null) return _arr([_lit('h')]); // hole: preserve slot, no gas
                return e.type === 'SpreadElement'
                    ? _arr([_lit('s'), e.argument])
                    : _arr([_lit('e'), e]);
            });
            return _call('__arrspread', [_arr(segs)]);
        }
        // object spread: {...x, k: v}  ->  __objspread([['s',x], ['p',['k',v]]])
        if (node.type === 'ObjectExpression' &&
            node.properties.some(function (p) { return p.type === 'SpreadElement'; })) {
            const simple = node.properties.every(function (p) {
                return p.type === 'SpreadElement' ||
                    (p.type === 'Property' && p.kind === 'init' && !p.method);
            });
            if (!simple) {
                // Accessor/method shorthand mixed with spread (e.g. {...o, m(){}}).
                // We cannot rebuild this through __objspread without changing the
                // getter/setter/method definition semantics (a method's `this` and a
                // getter's lazy evaluation must stay exactly as written), so we keep
                // the literal verbatim and only wrap each spread SOURCE in a
                // metering-only pass-through that charges by its own-key count and
                // returns it unchanged. The native spread still copies; it is no
                // longer a free O(n) operation, and method/accessor `this` is intact.
                node.properties.forEach(function (p) {
                    if (p.type === 'SpreadElement') {
                        p.argument = _call('__objspreadmeter', [p.argument]);
                    }
                });
                return node;
            }
            const segs = node.properties.map(function (p) {
                if (p.type === 'SpreadElement') return _arr([_lit('s'), p.argument]);
                const keyExpr = p.computed ? p.key
                    : (p.key.type === 'Identifier' ? _lit(p.key.name) : _lit(p.key.value));
                return _arr([_lit('p'), _arr([keyExpr, p.value])]);
            });
            return _call('__objspread', [_arr(segs)]);
        }
        // call / new / method argument spread: f(...x), new C(...x), arr.push(a, ...x)
        //   ->  f(...__arrspread([['s',x]])), new C(...__arrspread([['s',x]])), ...
        // The whole argument list is rebuilt through __arrspread (the same size-charged
        // helper array-literal spread uses): it copies every spread element once and
        // charges O(n) by count, then the native spread hands the flattened array to
        // the call. `this` (obj.method), evaluation order (segments build left-to-right)
        // and semantics are all preserved; non-spread args ride as ['e', arg] segments.
        // Reusing __arrspread (already a reserved harness helper) means no new reserved
        // identifier and no change to the deploy-time reserved-identifier verdict.
        // CONSENSUS-GATED: this adds an __arrspread charge that moves gasUsed, so it is
        // active only at/after the flag day (meterCallSpread, resolved from the block
        // time in index.js); pre-gate the call is emitted verbatim so historical blocks
        // replay byte-identically.
        if (meterCallSpread &&
            (node.type === 'CallExpression' || node.type === 'NewExpression') &&
            Array.isArray(node.arguments) &&
            node.arguments.some(function (a) { return a && a.type === 'SpreadElement'; })) {
            const segs = node.arguments.map(function (a) {
                return a.type === 'SpreadElement'
                    ? _arr([_lit('s'), a.argument])
                    : _arr([_lit('e'), a]);
            });
            node.arguments = [{ type: 'SpreadElement', argument: _call('__arrspread', [_arr(segs)]) }];
            return node;
        }
        // destructuring rest, addressable source:  var [x, ...c] = a  /  var {k, ...c} = o
        //   ->  var [x, ...c] = __arrspread([['s', a]])  /  var {k, ...c} = __objspreadmeter(o)
        // The pattern itself is untouched (its bindings, defaults, holes and evaluation
        // order all stay exactly as written); only the SOURCE is routed through the
        // size-charged helper, so the O(n) copy the rest performs is billed by count.
        // Over-charging by the few keys destructured out ahead of an object rest is
        // accepted: it is deterministic, and under-charging is the bug being closed.
        // A declarator with no init (a for-of/for-in head) has no source expression to
        // wrap and is left alone here; findBannedRest rejects it at deploy instead.
        // CONSENSUS-GATED for the same reason the call-spread rewrite is: it adds a
        // charge that moves gasUsed, so pre-gate the destructure is emitted verbatim.
        if (meterRestPattern && node.type === 'VariableDeclarator' && node.init) {
            node.init = _meterRestSource(node.id, node.init);
            return node;
        }
        if (meterRestPattern && node.type === 'AssignmentExpression' && node.operator === '=' &&
            (node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern')) {
            node.right = _meterRestSource(node.left, node.right);
            return node;
        }
        return node;
    }

    function recur(node) {
        if (!node || typeof node.type !== 'string') return node;
        const keys = Object.keys(node);
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    if (child[i] && typeof child[i].type === 'string') child[i] = recur(child[i]);
                }
            } else if (child && typeof child.type === 'string') {
                node[key] = recur(child);
            }
        }
        return convert(node);
    }

    recur(ast);
}

/**
 * Transform contract source code by injecting gas metering calls.
 * @param {string} source - Original contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.specEvalOrder] - L-3 consensus gate. When true, obj[k] += rhs
 *   is rewritten to the spec-correct order (read obj[k] before evaluating rhs) via
 *   __setconcatL; when false/omitted the historical __setconcat form is preserved
 *   byte-for-byte. index.js resolves this from the block time so pre-gate blocks
 *   replay identically. Consensus-visible: a divergent value forks the fleet.
 * @param {boolean} [opts.meterCallSpread] - consensus gate. When true, call/new/method
 *   argument spread (f(...x), new C(...x), arr.push(...x)) is rebuilt through the
 *   size-charged __arrspread helper so the O(n) element copy is metered; when
 *   false/omitted the call is emitted verbatim (legacy flat __gas(1)). index.js
 *   resolves this from the block time so pre-gate blocks replay identically.
 * @param {boolean} [opts.meterRestPattern] - consensus gate. When true, the SOURCE of a
 *   destructuring rest with an addressable source (`var [x, ...c] = a`,
 *   `var {k, ...c} = o`, and the assignment-expression forms) is wrapped in
 *   __arrspread / __objspreadmeter so the O(n) copy is metered; when false/omitted the
 *   destructure is emitted verbatim (legacy flat __gas(1)). index.js resolves this from
 *   the block time so pre-gate blocks replay identically.
 * @returns {string} Transformed source with __gas(1) calls injected
 */
function meterCode(source, opts) {
    const specEvalOrder = !!(opts && opts.specEvalOrder);
    const meterCallSpread = !!(opts && opts.meterCallSpread);
    const meterRestPattern = !!(opts && opts.meterRestPattern);
    const ast = acorn.parse(source, {
        ecmaVersion: CONTRACT_ECMA_VERSION,
        sourceType: 'script',
        locations: true
    });

    // Phase 0: rewrite syntax-level allocators (string +/+=, template literals,
    // array/object spread, and gated call/new argument spread) into metered helper
    // calls, on the pristine AST before any __gas() insertion. The helper calls are
    // exempted from Phase 3 below.
    transformAllocators(ast, specEvalOrder, meterCallSpread, meterRestPattern);

    // Track nodes we've already processed to avoid double-injection
    const processed = new WeakSet();

    // Charge gas at the top-level script entry point. The metered source runs
    // as a function body (new __Fn(..., meteredCode)), so top-level statements
    // (variable declarations, object-literal initializers, plain assignments)
    // would otherwise execute uncharged unless they happen to contain a call.
    // Inject after any directive prologue, exactly as function bodies are handled.
    insertGasAfterDirectives(ast.body);

    // Phase 1: Inject into function bodies, loop bodies, try/switch/if blocks
    walk.simple(ast, {
        // Function declarations and expressions: inject at entry
        FunctionDeclaration(node) {
            if (node.body && node.body.type === 'BlockStatement')
                insertGasAfterDirectives(node.body.body);
        },
        FunctionExpression(node) {
            if (node.body && node.body.type === 'BlockStatement')
                insertGasAfterDirectives(node.body.body);
        },
        ArrowFunctionExpression(node) {
            if (node.body.type === 'BlockStatement') {
                insertGasAfterDirectives(node.body.body);
            } else {
                // Expression body: () => expr  ->  () => (__gas(1), expr)
                node.body = wrapWithGas(node.body);
            }
        },

        // Loops: inject per iteration
        ForStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
            // Inject into update expression
            if (node.update) {
                node.update = {
                    type: 'SequenceExpression',
                    expressions: [gasCallExpr(), node.update]
                };
            } else {
                node.update = gasCallExpr();
            }
        },
        WhileStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        DoWhileStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        ForInStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },
        ForOfStatement(node) {
            ensureBlock(node, 'body');
            node.body.body.unshift(gasCallStatement());
        },

        // Conditionals
        IfStatement(node) {
            ensureBlock(node, 'consequent');
            node.consequent.body.unshift(gasCallStatement());
            if (node.alternate) {
                if (node.alternate.type === 'IfStatement') {
                    // else-if chain: will be handled when that IfStatement is visited
                } else {
                    ensureBlock(node, 'alternate');
                    node.alternate.body.unshift(gasCallStatement());
                }
            }
        },

        // Switch cases
        SwitchCase(node) {
            if (node.consequent.length > 0)
                node.consequent.unshift(gasCallStatement());
        },

        // Try/catch/finally
        TryStatement(node) {
            if (node.block && node.block.body)
                node.block.body.unshift(gasCallStatement());
            if (node.handler && node.handler.body && node.handler.body.body)
                node.handler.body.body.unshift(gasCallStatement());
            if (node.finalizer && node.finalizer.body)
                node.finalizer.body.unshift(gasCallStatement());
        },

        // Ternary operators: wrap test with gas
        ConditionalExpression(node) {
            if (!processed.has(node)) {
                processed.add(node);
                node.test = wrapWithGas(node.test);
            }
        }
    });

    // Phase 2: Inject into deeply nested BinaryExpressions
    // Walk the full AST and wrap the left operand at depth > 10
    walk.simple(ast, {
        BinaryExpression(node) {
            if (!processed.has(node) && binaryDepth(node) > 10) {
                processed.add(node);
                // Walk up the left chain to depth 10, then inject
                let current = node;
                let depth = 0;
                while (current.left && current.left.type === 'BinaryExpression' && depth < 10) {
                    current = current.left;
                    depth++;
                }
                // Wrap the left operand at depth 10 with gas
                if (current.left) {
                    current.left = wrapWithGas(current.left);
                }
            }
        }
    });

    // Phase 3: Inject before call expressions
    // We walk the full AST and wrap CallExpression nodes in their parent context
    walk.ancestor(ast, {
        CallExpression(node, ancestors) {
            if (processed.has(node)) return;
            // Don't inject into our own __gas call or the allocator metering
            // helpers (HELPER_SET, i.e. the ALLOC_HELPERS list above), which
            // already charge by size. Read that list rather than re-enumerating
            // it here; an inline copy has drifted before.
            if (node.callee.type === 'Identifier' &&
                (node.callee.name === '__gas' || HELPER_SET.has(node.callee.name))) return;
            // Don't inject into member calls on __gas (shouldn't exist, but defensive)
            if (node.callee.type === 'MemberExpression' &&
                node.callee.object.type === 'Identifier' &&
                node.callee.object.name === '__gas') return;

            processed.add(node);

            // Find the parent and replace this node with (__gas(1), call)
            const parent = ancestors[ancestors.length - 2];
            if (!parent) return;

            const wrapped = wrapWithGas(node);

            // Replace in parent: check all possible parent node shapes
            for (const key of Object.keys(parent)) {
                if (parent[key] === node) {
                    parent[key] = wrapped;
                    return;
                }
                if (Array.isArray(parent[key])) {
                    const idx = parent[key].indexOf(node);
                    if (idx !== -1) {
                        parent[key][idx] = wrapped;
                        return;
                    }
                }
            }
        }
    });

    // Phase 4: Deterministic call-depth bounding.
    // Wrap every contract function body as:
    //     __depth_enter(); try { <body> } finally { __depth_exit(); }
    // A native stack overflow (RangeError) fires at an architecture- and
    // host-stack-dependent depth; a contract that CATCHES the RangeError can read
    // that raw native depth and commit it into hashed state, so two validators on
    // different CPUs (or at different host call depths) diverge (fork). The harness
    // (src/index.js) enforces a fixed, platform-independent depth limit on these
    // enter/exit hooks, throwing a deterministic out_of_stack fault that cannot be
    // swallowed, so the maximum depth a contract can ever observe is identical on
    // every node. Runs LAST, after all __gas() injection, so the synthetic
    // try/finally is not itself gas-metered (depth bounding is gas-free, leaving the
    // gas cost of existing contracts unchanged) and the depth hooks are exempt from
    // the call-site wrapping above.
    walk.simple(ast, {
        FunctionDeclaration(node) { wrapDepthGuard(node); },
        FunctionExpression(node)  { wrapDepthGuard(node); },
        ArrowFunctionExpression(node) {
            // Convert an expression-bodied arrow to a block returning the
            // expression, so it can carry the enter/try/finally guard.
            if (node.body.type !== 'BlockStatement') {
                node.body = { type: 'BlockStatement',
                    body: [{ type: 'ReturnStatement', argument: node.body }] };
            }
            wrapDepthGuard(node);
        }
    });

    return generate(ast);
}

/**
 * Find the first reserved identifier used in the source, if any. Reserved names
 * are the harness-injected metering hooks (__gas + the allocator helpers); a
 * contract may not define or reference them or it could bypass/forge metering.
 * @param {string} source - Contract source code
 * @returns {string|null} the offending reserved name, or null if none
 */
function findReservedIdentifier(source) {
    try {
        const ast = acorn.parse(source, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script'
        });
        let found = null;
        // walk.full visits every node in the AST including nested Identifiers
        walk.full(ast, (node) => {
            if (!found && node.type === 'Identifier' && RESERVED_IDENTIFIERS.indexOf(node.name) !== -1) {
                found = node.name;
            }
        });
        return found;
    } catch (e) {
        // If parsing fails, let validateSyntax handle it
        return null;
    }
}

// Back-compat boolean form (the __gas-only check callers may still use).
function hasGasIdentifier(source) { return findReservedIdentifier(source) !== null; }

module.exports = { meterCode, hasGasIdentifier, findReservedIdentifier, RESERVED_IDENTIFIERS, CONTRACT_ECMA_VERSION };
