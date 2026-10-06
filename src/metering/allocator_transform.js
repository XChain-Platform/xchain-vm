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
 * XChain VM: metering allocator transformation
 ********************************************************************/
// @ts-nocheck

const walk = require('acorn-walk');
const { astLiteral, astArray, astCall, cloneNode, astVoid0, arrowThunk, memberKeyExpr } = require('./ast_builders.js');

// The rest-destructuring kind of a BINDING PATTERN, or null when the pattern carries
// no TOP-LEVEL rest. Only a rest that sits directly in the pattern being destructured
// has an addressable source expression to wrap; a rest nested one level deeper
// (`var {a: {...c}} = o`) reads an intermediate value with no expression to meter, and
// is rejected at deploy instead (lint_core findBannedRest).
function restKind(pat) {
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
function meterRestSource(pat, src) {
    const kind = restKind(pat);
    if (kind === 'obj') return astCall('__objspreadmeter', [src]);
    if (kind === 'arr') return astCall('__arrspread', [astArray([astArray([astLiteral('s'), src])])]);
    return src;
}

function convertConcat(node, specEvalOrder) {
    // string concatenation: a + b
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        return astCall('__concat', [node.left, node.right]);
    }
    if (node.type !== 'AssignmentExpression' || node.operator !== '+=') return null;
    // bare identifier: re-reading the lhs is side-effect-free, so charge
    // in place via  id = __concat(id, rhs).
    if (node.left.type === 'Identifier') {
        return {
            type: 'AssignmentExpression', operator: '=', left: node.left,
            right: astCall('__concat', [cloneNode(node.left), node.right])
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
            ? astCall('__setconcatL', [node.left.object, memberKeyExpr(node.left), arrowThunk(node.right)])
            : astCall('__setconcat', [node.left.object, memberKeyExpr(node.left), node.right]);
    }
    return null;
}

// tagged template: tag`q0${e0}q1...`  ->  __tmpltag[m](tag/obj[,key], cooked, raw, [e0,...])
// The quasi was skipped above (still raw); its expressions were already
// recursed (metered). Rebuild cooked/raw as literal arrays (cooked may be
// null for an invalid escape in a tagged template -> void 0 == undefined).
function convertTaggedTemplate(node) {
    if (node.type !== 'TaggedTemplateExpression') return null;
    const tl = node.quasi;
    const cooked = tl.quasis.map(function (q) {
        return q.value.cooked == null ? astVoid0() : astLiteral(q.value.cooked);
    });
    const raw = tl.quasis.map(function (q) { return astLiteral(q.value.raw); });
    const exprs = astArray(tl.expressions);
    // member tag (String.raw`...`, obj.m`...`, obj[k]`...`): this = object.
    if (node.tag.type === 'MemberExpression') {
        return astCall('__tmpltagm',
            [node.tag.object, memberKeyExpr(node.tag), astArray(cooked), astArray(raw), exprs]);
    }
    // plain tag (tag`...`, (0,f)`...`, getTag()`...`): this = undefined.
    return astCall('__tmpltag', [node.tag, astArray(cooked), astArray(raw), exprs]);
}

// template literal: `q0${e0}q1...`  ->  __tmpl([q0, e0, q1, ...])
function convertTemplateLiteral(node, taggedQuasis) {
    if (node.type !== 'TemplateLiteral' || taggedQuasis.has(node)) return null;
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
        parts.push(astLiteral(node.quasis[i].value.cooked));
        if (i < node.expressions.length) parts.push(node.expressions[i]);
    }
    return astCall('__tmpl', [astArray(parts)]);
}

// array spread: [a, ...x]  ->  __arrspread([['e',a], ['s',x]])
// Arrays that mix holes with spread are rewritten too: a hole becomes an
// ['h'] segment so __arrspread can recreate the sparse slot without copying
// (and without charging gas, since a hole moves no data), while spread
// sources are still charged O(n) by element count. Leaving such arrays
// unmetered would let [,...x] perform a free native O(n) copy.
function convertArraySpread(node) {
    if (node.type !== 'ArrayExpression' ||
        !node.elements.some(function (e) { return e && e.type === 'SpreadElement'; })) return null;
    const segs = node.elements.map(function (e) {
        if (e === null) return astArray([astLiteral('h')]); // hole: preserve slot, no gas
        return e.type === 'SpreadElement'
            ? astArray([astLiteral('s'), e.argument])
            : astArray([astLiteral('e'), e]);
    });
    return astCall('__arrspread', [astArray(segs)]);
}

// object spread: {...x, k: v}  ->  __objspread([['s',x], ['p',['k',v]]])
function convertObjectSpread(node) {
    if (node.type !== 'ObjectExpression' ||
        !node.properties.some(function (p) { return p.type === 'SpreadElement'; })) return null;
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
                p.argument = astCall('__objspreadmeter', [p.argument]);
            }
        });
        return node;
    }
    const segs = node.properties.map(function (p) {
        if (p.type === 'SpreadElement') return astArray([astLiteral('s'), p.argument]);
        const keyExpr = p.computed ? p.key
            : (p.key.type === 'Identifier' ? astLiteral(p.key.name) : astLiteral(p.key.value));
        return astArray([astLiteral('p'), astArray([keyExpr, p.value])]);
    });
    return astCall('__objspread', [astArray(segs)]);
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
function convertCallSpread(node, meterCallSpread) {
    if (!meterCallSpread ||
        (node.type !== 'CallExpression' && node.type !== 'NewExpression') ||
        !Array.isArray(node.arguments) ||
        !node.arguments.some(function (a) { return a && a.type === 'SpreadElement'; })) return null;
    const segs = node.arguments.map(function (a) {
        return a.type === 'SpreadElement'
            ? astArray([astLiteral('s'), a.argument])
            : astArray([astLiteral('e'), a]);
    });
    node.arguments = [{ type: 'SpreadElement', argument: astCall('__arrspread', [astArray(segs)]) }];
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
function convertRestPattern(node, meterRestPattern) {
    if (!meterRestPattern) return null;
    if (node.type === 'VariableDeclarator' && node.init) {
        node.init = meterRestSource(node.id, node.init);
        return node;
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=' &&
        (node.left.type === 'ArrayPattern' || node.left.type === 'ObjectPattern')) {
        node.right = meterRestSource(node.left, node.right);
        return node;
    }
    return null;
}

function convert(node, opts) {
    const converted =
        convertConcat(node, opts.specEvalOrder) ||
        convertTaggedTemplate(node) ||
        convertTemplateLiteral(node, opts.taggedQuasis) ||
        convertArraySpread(node) ||
        convertObjectSpread(node) ||
        convertCallSpread(node, opts.meterCallSpread) ||
        convertRestPattern(node, opts.meterRestPattern);
    return converted || node;
}

function recur(node, opts) {
    if (!node || typeof node.type !== 'string') return node;
    const keys = Object.keys(node);
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) {
                if (child[i] && typeof child[i].type === 'string') child[i] = recur(child[i], opts);
            }
        } else if (child && typeof child.type === 'string') {
            node[key] = recur(child, opts);
        }
    }
    return convert(node, opts);
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
 * are rejected at deploy on the same flag day instead (lint_core findBannedRest).
 */
function transformAllocators(ast, specEvalOrder, meterCallSpread, meterRestPattern) {
    // An untagged template literal is rewritten to __tmpl(...). A TAGGED template's
    // quasi must NOT be (the tag receives the raw template strings object); we
    // collect those quasis up front, skip converting them here, and instead rewrite
    // the whole TaggedTemplateExpression into a metered helper that rebuilds
    // the strings object and invokes the tag with the correct `this`.
    const taggedQuasis = new WeakSet();
    walk.simple(ast, { TaggedTemplateExpression: function (n) { taggedQuasis.add(n.quasi); } });
    recur(ast, { specEvalOrder, meterCallSpread, meterRestPattern, taggedQuasis });
}

module.exports = { transformAllocators };
