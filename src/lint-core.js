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
 * XChain VM: Contract Lint Core (dependency-light, no isolated-vm)
 *
 * The canonical, acorn-only contract validation rules. Every deploy-time
 * check EXCEPT the V8 syntax compile (step 1), which needs isolated-vm and
 * stays in syntax.js. Depends only on acorn / acorn-walk / astring (via
 * metering.js), so it is safe to run in a browser / any-Node context.
 *
 * THIS FILE IS A SHARED SOURCE OF TRUTH. xchain-sdk vendors a byte-identical
 * copy at src/contract/lint-core.js; a CI parity guard (sha256) fails the
 * build on drift. Edit here, then re-sync the vendored copy.
 *
 * lintSource(code) -> { errors: Rule[], warnings: Rule[] }
 *   where Rule = { rule: string, message: string, line: number|null }
 *
 * Message strings are BYTE-IDENTICAL to what syntax.js historically emitted.
 * validateSyntax returns errors[0].message verbatim, and checkFloatWarnings
 * returns warnings.map(w => w.message), so the deploy-path verdict (recorded
 * in on-chain execution records) is unchanged.
 ********************************************************************/
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { meterCode, findReservedIdentifier, CONTRACT_ECMA_VERSION } = require('./metering.js');

// Transcendental Math members that are non-deterministic across architectures
// and are no longer exposed in the sandbox. Calling them would fail at runtime;
// rejecting at deploy time turns that into a clear, early error.
const BANNED_MATH_MEMBERS = new Set(['sqrt', 'pow', 'log', 'log2', 'log10']);

// The FROZEN whitelist of Math members the sandbox's deterministic SafeMath
// subset exposes. MUST stay byte-equal to sandbox.js SAFE_MATH_MEMBERS (a
// parity test in xchain-vm asserts it); duplicated here (not required) so this
// file stays dependency-light for the vendored SDK/browser copies. Under the
// VM_LINT_HARDENING flag-day the banned set is the COMPLEMENT of this list:
// any statically-resolvable Math member NOT in it (Math.random, Math.atan2,
// future additions...) is rejected at deploy instead of failing at runtime.
const SAFE_MATH_MEMBERS = new Set([
    'floor', 'ceil', 'round', 'abs', 'min', 'max', 'sign', 'trunc', 'PI', 'E'
]);

// The CONTRACT_WRAPPER's injected control bindings (index.js). Legacy deploys
// compile them as script-level lexical bindings, visible from contract code
// (which is evaluated via the saved Function constructor in global scope), so
// a contract can read or shadow them to defeat crossCallable/manifest/method
// dispatch. Under VM_LINT_HARDENING the wrapper moves them into the IIFE
// closure AND the deploy validator rejects any reference to them
// (rule 'reserved-identifier'), mirroring the metering helper ban.
const RESERVED_CONTROL_BINDINGS = [
    '__contractCode', '__methodName', '__isCrossCall', '__readManifest'
];

// The deploy code-size cap, in UTF-8 BYTES. Inlined (not required from
// index.js or protocol/constants.js) for the same reason SAFE_MATH_MEMBERS is
// duplicated above: this file must be BYTE-IDENTICAL to the SDK's vendored copy
// at xchain-sdk/src/contract/lint-core.js, and constants.js sits at a different
// relative depth in each tree, so no single require() line resolves in both.
// It MUST stay equal to src/protocol/constants.js MAX_CODE_SIZE (and therefore
// to the indexer's deploy.js cap); a parity test asserts it.
const MAX_CODE_SIZE = 65536;

// The sandbox's hard-neutered prototype METHODS (sandbox.js
// STRIPPED_PROTO_METHODS). Duplicated here for the dependency-light reason
// above; a parity test asserts this list stays equal to sandbox.js.
// Two hazard classes, both consensus-relevant: the regex-coercing methods
// (match/matchAll/search) route a ReDoS through %RegExp% for ~1 gas even after
// the RegExp global is deleted, and the locale/ICU methods return host-ICU-
// version-dependent bytes. Calling any of them throws TypeError at runtime, so
// the linter's job here is to turn a first-execution failure into a deploy-time
// diagnostic. Matching is by METHOD NAME on a statically-resolvable call site,
// which cannot tell `someString.search(x)` from a contract's own
// `myIndex.search(x)`, so these are WARNINGS: never deploy-blocking, never in
// CONSENSUS_RULES, and never a false red on the CLI (bin/lint.js fails a file
// on error-severity findings only).
const STRIPPED_PROTO_METHOD_NAMES = [
    'match', 'matchAll', 'search',
    'normalize', 'localeCompare',
    'toLocaleLowerCase', 'toLocaleUpperCase', 'toLocaleString'
];
const REGEX_COERCING_METHODS = new Set(['match', 'matchAll', 'search']);

// The sandbox's deleted GLOBALS. NOT mirrored: required from the one module
// that defines them, ./stripped-globals.js, which sandbox.js and the AI-authoring
// knowledge base require too. That module is dependency-free precisely so this
// single require line resolves in BOTH trees at the two depths this file is
// vendored to (xchain-vm/src/ and xchain-sdk/src/contract/), which is the reason
// SAFE_MATH_MEMBERS and MAX_CODE_SIZE above still cannot be required: their
// homes (sandbox.js, protocol/constants.js) do not sit at a common relative
// path, and sandbox.js additionally pulls isolated-vm, which this file must
// never load. The SDK vendors stripped-globals.js byte-identically under the
// same sha256 parity guard as this file.
const {
    STRIPPED_GLOBAL_NAMES,
    ADVISORY_STRIPPED_GLOBAL_NAMES
} = require('./stripped-globals.js');

// Retained under its historical export name: the list is no longer a mirror,
// but callers (and the SDK's vendored copy's tests) import it by this name.
const STRIPPED_GLOBAL_NAMES_MIRROR = STRIPPED_GLOBAL_NAMES;

// The subset this file WARNS on: every name stripped from genesis on every
// network, so the warning's claim holds unconditionally. The two consensus-gated
// names (Promise, WebAssembly) are held out by stripped-globals.js, which
// explains why that is not a gap.
const ADVISORY_STRIPPED_GLOBALS = ADVISORY_STRIPPED_GLOBAL_NAMES;

// True if `node` is a static reference to the global Math object: the bare
// identifier `Math`, or a global-object-qualified form (`globalThis.Math` /
// `globalThis['Math']` / `globalThis[\`Math\`]`, the last via a template
// literal with no substitutions).
//
// The qualifying object leg is resolved by isGlobalObjectRef, so under the
// LINT_GLOBAL_ALIAS epoch (`aliased`) the widened spellings that rule already
// recognizes for banned-async and banned-wasm count here too: `this.Math.pow`
// and `globalThis.globalThis.Math.log` read the same global Math the rule
// targets. With `aliased` false only the bare `globalThis` identifier qualifies,
// which is byte-for-byte the pre-epoch behaviour, so a from-genesis replay below
// the activation reproduces the historical verdict.
function isMathObjectRef(node, aliased) {
    if (!node) return false;
    if (node.type === 'Identifier' && node.name === 'Math') return true;
    if (node.type === 'MemberExpression' && isGlobalObjectRef(node.object, aliased))
        return staticMemberKey(node) === 'Math';
    return false;
}

// If `node` is a computed MemberExpression whose property statically resolves
// to a string (a string Literal, or a TemplateLiteral with no substitution
// expressions), return that string; otherwise null. Handles `obj['key']` and
// `obj[\`key\`]` alike; variable-computed access (`obj[x]`) is intentionally
// left unresolved (out of scope, needs data-flow analysis).
function staticComputedKey(node) {
    if (!node.computed || !node.property) return null;
    const p = node.property;
    if (p.type === 'Literal' && typeof p.value === 'string') return p.value;
    if (p.type === 'TemplateLiteral' && p.expressions.length === 0 && p.quasis.length === 1)
        return p.quasis[0].value.cooked;
    return null;
}

// The property name a MemberExpression reads, when it resolves statically: the
// non-computed identifier (`o.k`), or a computed string / no-substitution template
// (`o['k']`, o[`k`]). null when resolving it would need data-flow analysis (`o[x]`).
function staticMemberKey(node) {
    if (!node || node.type !== 'MemberExpression' || !node.property) return null;
    if (node.computed) return staticComputedKey(node);
    return node.property.type === 'Identifier' ? node.property.name : null;
}

// True if `node` statically denotes the GLOBAL OBJECT.
//
// Legacy spelling (always recognized): the bare identifier `globalThis`.
//
// Under the LINT_GLOBAL_ALIAS activation epoch (`aliased`) two further spellings
// denote the same object and are recognized as well:
//   - `this`. Contract code is evaluated by the saved Function constructor in
//     global scope as SLOPPY-mode script, where top-level `this` IS globalThis,
//     and a plain `f()` call gives a sloppy function body the same receiver. So
//     `this.WebAssembly` / `this.Promise` is a global read that the
//     identifier-precise rules never saw.
//   - a self-referential alias chain of any depth: `globalThis.globalThis`,
//     `globalThis['globalThis']`, `this.globalThis`,
//     `globalThis.globalThis.globalThis`... The global object carries a
//     `globalThis` self-reference, so every link denotes the global object again,
//     and the single-hop `node.object.name === 'globalThis'` check walked past
//     all of them.
//
// The `this` leg deliberately fails CLOSED, the same direction the shadowed-local
// scope scan in findBannedAsync takes: a `this` bound by a METHOD call to a
// contract's own object is NOT the global object, so
// `{ Promise: 1, f() { return this.Promise; } }` is rejected too. Accepting that
// false positive is the safe direction for an error-severity CONSENSUS_RULE
// guarding an unmetered / nondeterministic surface, and it is exactly why this
// tightening MUST ride its own activation epoch: it moves DEPLOY verdicts, so it
// may only apply at or after a height the whole fleet agrees on. Below the
// activation `aliased` is false and every spelling resolves as it historically did.
function isGlobalObjectRef(node, aliased) {
    if (!node) return false;
    if (node.type === 'Identifier' && node.name === 'globalThis') return true;
    if (!aliased) return false;
    if (node.type === 'ThisExpression') return true;
    if (node.type === 'MemberExpression')
        return staticMemberKey(node) === 'globalThis' && isGlobalObjectRef(node.object, aliased);
    return false;
}

/**
 * Scan contract code for references to banned transcendental Math members
 * (Math.sqrt / Math.pow / Math.log / Math.log2 / Math.log10), in dotted
 * (Math.pow), computed-string (Math['pow'] / Math[`pow`]), and
 * globalThis-qualified (globalThis.Math.pow, globalThis['Math'].pow) forms, plus
 * (under LINT_GLOBAL_ALIAS, `aliased`) the widened global-object spellings
 * this.Math.pow and globalThis.globalThis.Math.pow.
 *
 * Under VM_LINT_HARDENING (`hardened`), the ban derives from the COMPLEMENT of
 * the sandbox's SAFE_MATH_MEMBERS whitelist: every statically-resolvable Math
 * member outside it (Math.random included) is rejected at deploy, matching what
 * the sandbox actually exposes, instead of failing only at runtime.
 *
 * @param {string} code - Contract source code
 * @param {boolean} [hardened=true] - VM_LINT_HARDENING consensus flag
 * @param {boolean} [aliased=true] - LINT_GLOBAL_ALIAS consensus flag: also count
 *        sloppy-mode `this` and the `globalThis.globalThis...` self-reference
 *        chain as the global object qualifying `Math`, exactly as banned-async
 *        and banned-wasm already do. Defaults to true for author-facing callers
 *        (SDK linter, CLI, unit tests), as the sibling scanners do.
 * @returns {Array<{name: string, line: (number|string), transcendental: boolean}>}
 */
function findBannedMathCalls(code, hardened, aliased) {
    if (hardened === undefined) hardened = true;
    if (aliased === undefined) aliased = true;
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
    } catch (e) {
        // Parse failure; validateSyntax's earlier checks would have caught this.
        return hits;
    }
    walk.simple(ast, {
        MemberExpression(node) {
            if (!isMathObjectRef(node.object, aliased)) return;
            let member = null;
            if (!node.computed && node.property && node.property.type === 'Identifier') {
                member = node.property.name;                 // Math.pow
            } else if (node.computed) {
                member = staticComputedKey(node);             // Math['pow'] / Math[`pow`]
            }
            if (!member) return;
            if (BANNED_MATH_MEMBERS.has(member)) {
                hits.push({ name: member, line: node.loc ? node.loc.start.line : '?', transcendental: true });
            } else if (hardened && !SAFE_MATH_MEMBERS.has(member)) {
                hits.push({ name: member, line: node.loc ? node.loc.start.line : '?', transcendental: false });
            }
        }
    });
    return hits;
}

/**
 * UTF-8 byte length of the contract source, the unit the deploy cap is measured
 * in. TextEncoder (not Buffer) so the vendored SDK copy stays browser-safe;
 * the two agree byte for byte on every input, unpaired surrogates included
 * (both emit the 3-byte U+FFFD replacement), which is what makes this
 * measurement byte-identical to the on-chain
 * `Buffer.byteLength(code, 'utf8')` at xchain-indexer/src/actions/deploy.js.
 *
 * @param {string} code - Contract source code
 * @returns {number} UTF-8 byte length
 */
function codeSizeBytes(code) {
    return new TextEncoder().encode(code).length;
}

/**
 * Scan contract code for calls to a prototype method the sandbox hard-neuters
 * (String.match/matchAll/search, String.normalize/localeCompare, the
 * toLocale* family). Statically-resolvable call sites only: `x.match(...)` and
 * `x['match'](...)`; dynamic dispatch is out of reach, the same limitation
 * staticComputedKey already accepts elsewhere.
 *
 * Advisory by construction: a name-only match cannot distinguish a String
 * receiver from a contract's own object, so every hit is emitted as a WARNING
 * and 'banned-proto-method' is deliberately absent from CONSENSUS_RULES.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{name: string, line: (number|string), regex: boolean}>}
 */
function findBannedProtoMethods(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        // Parse failure; lintSource's metering pass reports it as blocking.
        return hits;
    }
    walk.simple(ast, {
        CallExpression(node) {
            const c = node.callee;
            if (!c || c.type !== 'MemberExpression') return;
            let name = null;
            if (!c.computed && c.property && c.property.type === 'Identifier') name = c.property.name;
            else if (c.computed) name = staticComputedKey(c);
            if (!name || STRIPPED_PROTO_METHOD_NAMES.indexOf(name) === -1) return;
            hits.push({
                name,
                line: node.loc ? node.loc.start.line : '?',
                regex: REGEX_COERCING_METHODS.has(name)
            });
        }
    });
    return hits;
}

/**
 * Scan contract code for the `**` / `**=` exponentiation operator (hardened
 * rule). Number::exponentiate is the same IEEE 754 transcendental path the
 * Math.pow ban targets, so `p ** q` was an unguarded consensus-fork hole.
 * Emitted under rule 'banned-math'; contracts use xchain.math.pow() instead.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{op: string, line: (number|string)}>}
 */
function findBannedExponentiation(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        BinaryExpression(node) {
            if (node.operator === '**')
                hits.push({ op: '**', line: node.loc ? node.loc.start.line : '?' });
        },
        AssignmentExpression(node) {
            if (node.operator === '**=')
                hits.push({ op: '**=', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for references to the CONTRACT_WRAPPER's injected control
 * bindings (hardened rule; see RESERVED_CONTROL_BINDINGS above). Returns the
 * first offending name or null, mirroring metering.js findReservedIdentifier.
 *
 * @param {string} code - Contract source code
 * @returns {string|null}
 */
function findReservedControlBinding(code) {
    let found = null;
    try {
        const ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script' });
        walk.full(ast, (node) => {
            if (!found && node.type === 'Identifier' && RESERVED_CONTROL_BINDINGS.indexOf(node.name) !== -1)
                found = node.name;
        });
    } catch (e) {
        // Parse failure; lintSource's metering pass reports it as blocking.
    }
    return found;
}

/**
 * Scan contract code for BigInt literals (10n) and RegExp literals (/.../), both of
 * which expose unmetered native computation. acorn marks BigInt literals with a
 * `bigint` property and RegExp literals with a `regex` property on the Literal node.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedLiterals(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        Literal(node) {
            if (node.bigint !== undefined && node.bigint !== null)
                hits.push({ kind: 'bigint', line: node.loc ? node.loc.start.line : '?' });
            else if (node.regex !== undefined && node.regex !== null)
                hits.push({ kind: 'regex', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

// True if binding pattern `pat` declares `name` (Identifier / default /
// rest / array / object destructuring, walked without descending into
// computed keys or default-value expressions).
function patternDeclares(pat, name) {
    if (!pat) return false;
    switch (pat.type) {
        case 'Identifier':        return pat.name === name;
        case 'AssignmentPattern': return patternDeclares(pat.left, name);
        case 'RestElement':       return patternDeclares(pat.argument, name);
        case 'ArrayPattern':      return (pat.elements || []).some((el) => patternDeclares(el, name));
        case 'ObjectPattern':     return (pat.properties || []).some((p) =>
            p.type === 'RestElement' ? patternDeclares(p.argument, name) : patternDeclares(p.value, name));
        default: return false;
    }
}

// True if ancestor node `node` IMMEDIATELY declares `name` in its own scope:
// function id/params, catch binding, a var/let/const/function/class statement
// directly in its body, or a for-loop declaration head. Deliberately does not
// descend into nested scopes (each ancestor is checked separately by the
// caller), and does not model hoisting order/TDZ: a TDZ read throws a
// deterministic in-isolate ReferenceError at runtime, which is safe.
function scopeDeclares(node, name) {
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression') {
        if (node.id && node.id.name === name) return true;
        return (node.params || []).some((p) => patternDeclares(p, name));
    }
    if (node.type === 'CatchClause') return patternDeclares(node.param, name);
    const stmts = (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock')
        ? node.body
        : (node.type === 'SwitchCase') ? node.consequent : null;
    if (stmts) {
        for (const s of stmts) {
            if (s.type === 'VariableDeclaration'
                && s.declarations.some((d) => patternDeclares(d.id, name))) return true;
            if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration')
                && s.id && s.id.name === name) return true;
        }
        return false;
    }
    if (node.type === 'ForStatement' && node.init && node.init.type === 'VariableDeclaration')
        return node.init.declarations.some((d) => patternDeclares(d.id, name));
    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement')
        && node.left && node.left.type === 'VariableDeclaration')
        return node.left.declarations.some((d) => patternDeclares(d.id, name));
    return false;
}

/**
 * Scan contract code for the async surface (async functions, await expressions,
 * and Promise references). The CONTRACT_WRAPPER invokes exports SYNCHRONOUSLY:
 * an `async` export returns a pending Promise (JSON.stringify(result) yields
 * "{}"), and whether its post-`await` state writes land depends on isolated-vm's
 * microtask-drain timing inside runSync, a property of the package version that
 * is NOT part of the consensus-runtime pin. A wall-clock interrupt landing
 * mid-drain turns a success on one validator into a timeout on another. async/
 * await is ES2017, so it parses clean under the ES2020 deploy pin and meters
 * cleanly; reject it at the syntax layer like BigInt/RegExp literals (the
 * sandbox also strips the Promise global as defense in depth).
 *
 * Under VM_LINT_HARDENING (`hardened`) three refinements apply:
 *   - dynamic `import('x')` is rejected (kind 'import'): it parses cleanly under
 *     the ES2020 pin with no async keyword and no Promise identifier, yet
 *     evaluates to a Promise, the exact microtask surface this rule excludes;
 *   - the shorthand property `{ Promise }` is rejected in BOTH modes (acorn
 *     materializes distinct key/value nodes, so the object-key skip never
 *     suppressed the value read; locked in by unit tests);
 *   - a lexically-shadowed LOCAL `Promise` (parameter / var / let / const /
 *     function / class / catch binding in an enclosing scope) is ACCEPTED:
 *     it never resolves to the global binding, so the legacy reject was a
 *     linter-vs-runtime over-reject. The scope scan is a deterministic
 *     ancestor-scope approximation; a miss fails CLOSED (legacy reject).
 *
 * Under the separate LINT_GLOBAL_ALIAS epoch (`aliased`) the global-object half of
 * the rule stops being single-hop: `this.Promise` (sloppy-mode `this` IS globalThis
 * in the Function-constructor evaluation the CONTRACT_WRAPPER uses) and any depth of
 * the `globalThis.globalThis...` self-reference chain resolve to the global Promise
 * and are flagged. See isGlobalObjectRef for why that leg fails closed and why it
 * needs an epoch of its own rather than riding VM_LINT_HARDENING (already open).
 *
 * @param {string} code - Contract source code
 * @param {boolean} [hardened=true] - VM_LINT_HARDENING consensus flag
 * @param {boolean} [aliased=true] - LINT_GLOBAL_ALIAS consensus flag
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedAsync(code, hardened, aliased) {
    if (hardened === undefined) hardened = true;
    if (aliased === undefined) aliased = true;
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    const markAsync = (node) => {
        if (node.async) hits.push({ kind: 'async', line: node.loc ? node.loc.start.line : '?' });
    };
    walk.ancestor(ast, {
        FunctionDeclaration: markAsync,
        FunctionExpression: markAsync,
        ArrowFunctionExpression: markAsync,
        AwaitExpression(node) {
            hits.push({ kind: 'await', line: node.loc ? node.loc.start.line : '?' });
        },
        Identifier(node, state, ancestors) {
            if (node.name !== 'Promise') return;
            // Only the GLOBAL Promise is banned. Skip the property position of a
            // member access (obj.Promise) and a non-computed object-literal key
            // ({ Promise: ... }): those never resolve to the global binding.
            // Note: the shorthand `{ Promise }` DOES read the global binding and
            // is caught here in both modes: acorn materializes distinct key and
            // value nodes for a shorthand property, so the key-skip below never
            // suppresses the value read (efc8c624, locked in by unit tests).
            const parent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
            if (parent) {
                if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
            }
            // Hardened: a Promise that resolves to an in-scope LOCAL declaration
            // is not the global binding; accept it (see doc comment above).
            if (hardened) {
                for (let i = ancestors.length - 2; i >= 0; i--) {
                    if (scopeDeclares(ancestors[i], 'Promise')) return;
                }
            }
            hits.push({ kind: 'promise', line: node.loc ? node.loc.start.line : '?' });
        },
        ImportExpression(node) {
            // Hardened: dynamic import() evaluates to a Promise (kind 'import').
            if (hardened)
                hits.push({ kind: 'import', line: node.loc ? node.loc.start.line : '?' });
        },
        MemberExpression(node) {
            // globalThis.Promise / globalThis['Promise'] / globalThis[`Promise`], and
            // (aliased) this.Promise / globalThis.globalThis...Promise.
            if (!isGlobalObjectRef(node.object, aliased)) return;
            if (staticMemberKey(node) === 'Promise')
                hits.push({ kind: 'promise', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for generator functions (function*, generator methods, and
 * yield at any depth). A suspended generator frame is entered via __depth_enter
 * but its matching __depth_exit never runs until the generator is drained, so
 * many opened-but-undrained generators accumulate __stackDepth toward the 512
 * MAX_STACK_DEPTH cap and trip a spurious deterministic out_of_stack (29912bd8).
 * The verdict is identical on every validator (not a fork) but a robustness
 * quirk the deploy validator should reject up front rather than surface as a
 * confusing runtime out_of_stack.
 *
 * A generator FunctionDeclaration/FunctionExpression is marked `node.generator`;
 * an object/class generator METHOD is a FunctionExpression value with the same
 * flag, so walking the two function-node types covers `*gen(){}` shorthand and
 * class generator methods alike. YieldExpression is flagged directly too so the
 * ban reads as "no yield at any depth"; a bare identifier named `yield` (legal
 * in sloppy-mode script, never a YieldExpression) is intentionally NOT matched.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedGenerator(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    const markGen = (node) => {
        if (node.generator) hits.push({ kind: 'generator', line: node.loc ? node.loc.start.line : '?' });
    };
    walk.simple(ast, {
        FunctionDeclaration: markGen,
        FunctionExpression: markGen,
        YieldExpression(node) {
            hits.push({ kind: 'yield', line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for references to the global `WebAssembly` binding. wasm
 * bodies execute native code that carries no __gas metering (unmetered native
 * execution) and are a consensus-fork surface, so the sandbox strips the global
 * at the Pkg 3 height flag-day (75190596); this is the deploy-lint half.
 *
 * Matching is by IDENTIFIER, so the false-positive hazard the seq-2669 proto-
 * method rule accepts (a name-only call site cannot tell `s.search(x)` from a
 * contract's own `myIndex.search(x)`, forcing WARNING severity) does NOT apply
 * here: this rule matches ONLY a reference that resolves to the global binding.
 * A member-access property (`obj.WebAssembly`), a non-computed object-literal
 * KEY (`{ WebAssembly: ... }`), and a lexically-shadowed local (parameter / var
 * / let / const / function / class / catch binding named WebAssembly) are all
 * excluded because none reads the global; the shorthand `{ WebAssembly }` value
 * IS the global read and is flagged, and `globalThis.WebAssembly` /
 * `globalThis['WebAssembly']` are the same binding under another spelling. That
 * precision (identical in construction to the global-Promise handling in
 * findBannedAsync) is what lets this be an error-severity CONSENSUS_RULE rather
 * than a name-only advisory.
 *
 * Under the LINT_GLOBAL_ALIAS epoch (`aliased`) the global-object spelling widens
 * exactly as it does in findBannedAsync: `this.WebAssembly` and any depth of
 * `globalThis.globalThis...WebAssembly` read the same global binding. See
 * isGlobalObjectRef.
 *
 * @param {string} code - Contract source code
 * @param {boolean} [aliased=true] - LINT_GLOBAL_ALIAS consensus flag
 * @returns {Array<{line: (number|string)}>}
 */
function findBannedWasm(code, aliased) {
    if (aliased === undefined) aliased = true;
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.ancestor(ast, {
        Identifier(node, state, ancestors) {
            if (node.name !== 'WebAssembly') return;
            // Skip the property position of a member access (obj.WebAssembly) and a
            // non-computed object-literal key ({ WebAssembly: ... }): neither reads
            // the global. The shorthand { WebAssembly } materializes a distinct value
            // node whose parent.value (not parent.key) is this node, so it falls
            // through and IS flagged (mirrors the { Promise } handling).
            const parent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
            if (parent) {
                if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
            }
            // A WebAssembly that resolves to an in-scope LOCAL declaration is not the
            // global binding; accept it. Deterministic ancestor-scope approximation,
            // failing CLOSED (flag) on a miss, exactly as findBannedAsync does for Promise.
            for (let i = ancestors.length - 2; i >= 0; i--) {
                if (scopeDeclares(ancestors[i], 'WebAssembly')) return;
            }
            hits.push({ line: node.loc ? node.loc.start.line : '?' });
        },
        MemberExpression(node) {
            // globalThis.WebAssembly / globalThis['WebAssembly'] / globalThis[`WebAssembly`],
            // and (aliased) this.WebAssembly / globalThis.globalThis...WebAssembly.
            if (!isGlobalObjectRef(node.object, aliased)) return;
            if (staticMemberKey(node) === 'WebAssembly')
                hits.push({ line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for reads of a global the sandbox DELETES
 * (ADVISORY_STRIPPED_GLOBALS). Author-facing WARNING only: the deploy gate
 * blocks on CONSENSUS_RULES and this rule is deliberately not in it, so the
 * on-chain verdict is byte-for-byte what it was before this rule existed. What
 * it buys is that a contract reaching `Date.now()`, `fetch(url)` or
 * `structuredClone(v)` is told so at lint time, instead of deploying clean and
 * throwing ReferenceError on its FIRST execution inside the isolate.
 *
 * Deliberately a SEPARATE walk rather than a generalization of findBannedWasm:
 * that scanner feeds the error-severity, CONSENSUS_RULES-member `banned-wasm`
 * whose findings are gated into the on-chain deploy verdict, so refactoring it
 * to serve an advisory rule would put a consensus surface at risk for a
 * cosmetic saving. The matching logic here is deliberately identical to it.
 *
 * Identifier-precise, exactly as findBannedWasm is: the property position of a
 * non-computed member access (`obj.Date`), a non-computed object-literal key
 * (`{ Date: 1 }`) and an identifier resolving to an in-scope local declaration
 * are all skipped, so a contract's own binding is never flagged. Shorthand
 * `{ Date }` IS flagged (acorn materializes a distinct value node). The
 * global-object-qualified spellings (`globalThis.fetch`, `globalThis['fetch']`,
 * and under `aliased` `this.fetch`) are flagged through isGlobalObjectRef.
 *
 * @param {string} code - Contract source code
 * @param {boolean} [aliased=true] - LINT_GLOBAL_ALIAS consensus flag
 * @param {string[]} [names] - name set to scan for (defaults to
 *        ADVISORY_STRIPPED_GLOBALS; injectable so tests can drive one name)
 * @returns {Array<{name: string, line: (number|string)}>}
 */
function findBannedStrippedGlobals(code, aliased, names) {
    if (aliased === undefined) aliased = true;
    const wanted = new Set(names || ADVISORY_STRIPPED_GLOBALS);
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        // Parse failure; lintSource's metering pass reports it as blocking.
        return hits;
    }
    walk.ancestor(ast, {
        Identifier(node, state, ancestors) {
            if (!wanted.has(node.name)) return;
            const parent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
            if (parent) {
                if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
            }
            // An in-scope local of the same name is the contract's own binding, not
            // the global. Same deterministic ancestor-scope approximation the
            // consensus scanners use; it fails CLOSED (warn) on a miss, which for a
            // warning costs an author one false line and never a red build.
            for (let i = ancestors.length - 2; i >= 0; i--) {
                if (scopeDeclares(ancestors[i], node.name)) return;
            }
            hits.push({ name: node.name, line: node.loc ? node.loc.start.line : '?' });
        },
        MemberExpression(node) {
            if (!isGlobalObjectRef(node.object, aliased)) return;
            const key = staticMemberKey(node);
            if (key && wanted.has(key))
                hits.push({ name: key, line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Scan contract code for non-integer (decimal) number literals (a non-blocking
 * warning that native float arithmetic is being used). Returns structured rules;
 * checkFloatWarnings flattens these to their message strings.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{rule: string, message: string, line: (number|null)}>}
 */
function findFloatWarnings(code) {
    const warnings = [];
    try {
        const ast = acorn.parse(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
        walk.simple(ast, {
            Literal(node) {
                if (typeof node.value === 'number' && !Number.isInteger(node.value)) {
                    const line = node.loc ? node.loc.start.line : '?';
                    warnings.push({
                        rule: 'float-literal',
                        message:
                            'WARNING: decimal number literal (' + node.value +
                            ') detected at line ' + line +
                            '; use xchain.math for deterministic arithmetic',
                        line: node.loc ? node.loc.start.line : null,
                        severity: 'warning'
                    });
                }
            }
        });
    } catch (e) {
        // Parse failure; validateSyntax/lintSource report it as a blocking error.
    }
    return warnings;
}

// Move 2: logic-level lint rules (advisory; NEVER deploy-blocking).
// CONSENSUS_RULES are the only findings the on-chain deploy validator
// (validateSyntax -> xchain-indexer/deploy.js) acts on. Everything analyzeContract
// adds is author-facing signal for the SDK linter and the CLI; it must not change
// what the chain accepts, or the Move-1 deploy-parity invariant breaks. Keep this
// set in lockstep with the error-severity rules emitted above lintSource's Move-2
// section.
const CONSENSUS_RULES = new Set([
    'invalid-type',
    'unsupported-syntax',
    'reserved-identifier',
    'banned-math',
    'banned-literal',
    'banned-async',
    // Pkg 3 VM-sandbox bundle (CONSENSUS_VERSION 3, per-coin height flag-day). The
    // generator ban (29912bd8) and the WebAssembly deploy-lint ban (75190596, the
    // deploy half of the runtime global strip) ship in the same unshipped v3 epoch;
    // both are error-severity and precisely identify their target, so they belong in
    // the deploy-blocking set (their on-chain activation is the indexer's per-coin
    // gate, threaded through validateSyntax as enforceBannedGenerator/enforceBannedWasm).
    'banned-generator',
    'banned-wasm'
]);

const TYPED_ARRAY_CTORS = new Set([
    'Array', 'ArrayBuffer', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
    'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'
]);
const BULK_ALLOC_METHODS = new Set(['fill', 'repeat', 'padStart', 'padEnd']);

function lineOf(node) { return node && node.loc ? node.loc.start.line : null; }

// True if `node` is a call to xchain.state.get(...) / state.get(...). Used to spot a
// state read whose (possibly null) result is dereferenced without a guard.
function isStateGetCall(node) {
    if (!node || node.type !== 'CallExpression') return false;
    const c = node.callee;
    if (!c || c.type !== 'MemberExpression' || c.computed) return false;
    if (!c.property || c.property.name !== 'get') return false;
    const o = c.object;
    if (!o) return false;
    if (o.type === 'Identifier' && o.name === 'state') return true;       // state.get(...)
    return o.type === 'MemberExpression' && !o.computed && o.property && o.property.name === 'state'; // xchain.state.get(...)
}

// The simple callee name of a call: the identifier (foo(...)) or the dotted member
// property (x.foo(...)). null for computed/complex callees.
function calleeName(node) {
    if (!node || node.type !== 'CallExpression' || !node.callee) return null;
    const c = node.callee;
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression' && !c.computed && c.property) return c.property.name;
    return null;
}

// Locate the `module.exports = { ... }` object literal, returning { obj, methodNames }.
// methodNames = property keys whose value is a function (the contract's callable surface).
function findExportsObject(ast) {
    let obj = null;
    walk.simple(ast, {
        AssignmentExpression(node) {
            if (obj) return;
            const l = node.left;
            const isModuleExports = l && l.type === 'MemberExpression' && !l.computed
                && l.object && l.object.type === 'Identifier' && l.object.name === 'module'
                && l.property && l.property.name === 'exports';
            if (isModuleExports && node.right && node.right.type === 'ObjectExpression')
                obj = node.right;
        }
    });
    const methodNames = new Set();
    if (obj) {
        for (const p of obj.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = p.key && (p.key.name || p.key.value);
            const v = p.value;
            if (key && v && (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression'))
                methodNames.add(String(key));
        }
    }
    return { obj, methodNames };
}

// Move 2 analysis. Returns { errors, warnings } of {rule,message,line,severity}.
// Fully defensive: any parse/walk failure yields no findings rather than throwing
// into lintSource (and therefore the deploy path).
function analyzeContract(code) {
    const errors = [];
    const warnings = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return { errors, warnings };
    }

    try {
        const { obj, methodNames } = findExportsObject(ast);

        // ── crossCallable integrity ──────────────────────────────────────────
        // A non-array crossCallable makes EVERY cross-chain call to this contract
        // fail at runtime (XCALL_NOT_CALLABLE, thrown before any code runs); an
        // entry naming a non-exported method is a silent typo (that method stays
        // uncallable cross-chain).
        if (obj) {
            for (const p of obj.properties) {
                if (p.type !== 'Property' || p.computed) continue;
                const key = p.key && (p.key.name || p.key.value);
                if (key !== 'crossCallable') continue;
                const v = p.value;
                if (v && v.type === 'ArrayExpression') {
                    for (const el of v.elements) {
                        if (el && el.type === 'Literal' && typeof el.value === 'string'
                            && !methodNames.has(el.value)) {
                            warnings.push({
                                rule: 'crossCallable-unknown-method',
                                message: 'crossCallable lists "' + el.value + '" at line ' + lineOf(el) +
                                         ', which is not an exported method (it will be uncallable cross-chain; typo?)',
                                line: lineOf(el),
                                severity: 'warning'
                            });
                        }
                    }
                } else if (v && v.type !== 'Identifier' && v.type !== 'CallExpression'
                           && v.type !== 'ConditionalExpression' && v.type !== 'LogicalExpression') {
                    // Statically a non-array value (Literal/Object/Function/…). Dynamic
                    // forms (Identifier/call/etc.) are left alone to avoid false positives.
                    errors.push({
                        rule: 'crossCallable-not-array',
                        message: 'crossCallable must be an array of method names at line ' + lineOf(v) +
                                 '; a non-array value makes every cross-chain call to this contract fail (XCALL_NOT_CALLABLE)',
                        line: lineOf(v),
                        severity: 'error'
                    });
                }
            }
        }

        // ── unbounded-loop ───────────────────────────────────────────────────
        // Structurally unbounded loops (while(true) / for(;;) / do…while(true)).
        // The gas ceiling still bounds them at runtime; this is an advisory that
        // termination rests entirely on an internal break.
        const isTrue = (t) => t && t.type === 'Literal' && t.value === true;
        walk.simple(ast, {
            WhileStatement(n)   { if (isTrue(n.test)) pushUnbounded(n); },
            DoWhileStatement(n) { if (isTrue(n.test)) pushUnbounded(n); },
            ForStatement(n)     { if (n.test === null || n.test === undefined) pushUnbounded(n); }
        });
        function pushUnbounded(n) {
            warnings.push({
                rule: 'unbounded-loop',
                message: 'unbounded loop at line ' + lineOf(n) +
                         '; termination depends entirely on an internal break (the gas ceiling will halt it otherwise)',
                line: lineOf(n),
                severity: 'warning'
            });
        }

        // ── large-allocation ─────────────────────────────────────────────────
        // Bulk allocations the VM gas-meters at runtime; flagged so authors keep
        // the size bounded (an input-sized allocation can hit the gas ceiling).
        walk.simple(ast, {
            NewExpression(n) {
                if (n.callee && n.callee.type === 'Identifier' && TYPED_ARRAY_CTORS.has(n.callee.name))
                    pushAlloc(n, n.callee.name);
            },
            CallExpression(n) {
                if (n.callee && n.callee.type === 'Identifier' && n.callee.name === 'Array')
                    pushAlloc(n, 'Array');
                else if (n.callee && n.callee.type === 'MemberExpression' && !n.callee.computed
                         && n.callee.property && BULK_ALLOC_METHODS.has(n.callee.property.name))
                    pushAlloc(n, '.' + n.callee.property.name + '()');
            }
        });
        function pushAlloc(n, what) {
            warnings.push({
                rule: 'large-allocation',
                message: 'bulk allocation (' + what + ') at line ' + lineOf(n) +
                         '; gas-metered at runtime, keep the size bounded so it cannot hit the gas ceiling',
                line: lineOf(n),
                severity: 'warning'
            });
        }

        // ── unchecked-state-get ──────────────────────────────────────────────
        // A state.get(...) result dereferenced directly. state.get returns null for
        // an absent key, so `state.get('k').foo` throws on a missing key. Guard with
        // a default (`|| '0'`) or a require() first.
        walk.simple(ast, {
            MemberExpression(n) { if (isStateGetCall(n.object)) pushUnchecked(n); }
        });
        function pushUnchecked(n) {
            warnings.push({
                rule: 'unchecked-state-get',
                message: 'state.get(...) result dereferenced at line ' + lineOf(n) +
                         ' without a null guard; an absent key returns null and will throw. Default it (e.g. `|| \'0\'`) or require() it first',
                line: lineOf(n),
                severity: 'warning'
            });
        }

        // ── missing-input-validation ─────────────────────────────────────────
        // An exported method that reads call inputs (getInputParam) but contains no
        // require() check, likely accepting unvalidated input.
        if (obj) {
            for (const p of obj.properties) {
                if (p.type !== 'Property' || p.computed) continue;
                const v = p.value;
                if (!v || (v.type !== 'FunctionExpression' && v.type !== 'ArrowFunctionExpression')) continue;
                let readsInput = false, hasRequire = false;
                walk.simple(v, {
                    CallExpression(c) {
                        const n = calleeName(c);
                        if (n === 'getInputParam') readsInput = true;
                        // Any require()/require*-named call counts as validation. This
                        // covers xchain.require AND helper guards (requirePositive,
                        // requireAddress, requireStatus, …) so delegating validation to
                        // a helper is not flagged as missing.
                        if (n && (n === 'require' || n.indexOf('require') === 0)) hasRequire = true;
                    }
                });
                if (readsInput && !hasRequire) {
                    const key = p.key && (p.key.name || p.key.value);
                    warnings.push({
                        rule: 'missing-input-validation',
                        message: 'method "' + key + '" at line ' + lineOf(v) +
                                 ' reads input params but has no require() validation; validate inputs before use',
                        line: lineOf(v),
                        severity: 'warning'
                    });
                }
            }
        }
    } catch (e) {
        // Any detector failure -> drop Move-2 findings; never break lintSource.
        return { errors, warnings };
    }

    return { errors, warnings };
}

/**
 * Run every acorn-coverable contract rule (steps 2–5 of validateSyntax + the
 * float warnings) plus the Move-2 logic-level advisories. The V8 syntax compile
 * (step 1) is NOT here; it needs isolated-vm and stays in syntax.js.
 *
 * Consensus errors are returned in deploy-check order (metering -> reserved ->
 * banned-math -> banned-literal -> banned-async -> banned-generator -> banned-wasm)
 * FIRST, so errors[0] (filtered to CONSENSUS_RULES) is exactly the failure
 * validateSyntax surfaces. Move-2 findings (advisory) are appended after and never
 * affect the deploy verdict.
 *
 * @param {string} code - Contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.hardened=true] - apply the VM_LINT_HARDENING rule set
 *        (exponentiation ban, reserved control bindings, SAFE_MATH complement,
 *        dynamic import(), shorthand { Promise }, shadowed-local Promise
 *        relaxation). CONSENSUS-GATED on the deploy path: the indexer resolves
 *        protocol_changes.isEnabled('VM_LINT_HARDENING') per block so a
 *        from-genesis replay reproduces the historical verdicts. Defaults to
 *        true for author-facing callers (SDK linter, CLI, unit tests).
 * @param {boolean} [opts.globalAlias=true] - apply the LINT_GLOBAL_ALIAS rule
 *        refinement: sloppy-mode `this` and the `globalThis.globalThis...` self-
 *        reference chain count as the global object for banned-async,
 *        banned-wasm and banned-math. Its OWN activation epoch, not VM_LINT_HARDENING's: that gate
 *        is already open on every network, so riding it would retroactively reject
 *        contracts already accepted. Resolved per-coin on block HEIGHT (xchain-vm
 *        LINT_GLOBAL_ALIAS_ACTIVATION / xchain-indexer
 *        vm_lint_global_alias_activation.js). Defaults to true for author-facing
 *        callers (SDK linter, CLI, unit tests).
 * @returns {{ errors: Array<{rule,message,line,severity}>, warnings: Array<{rule,message,line,severity}> }}
 */
function lintSource(code, opts) {
    const hardened = !opts || opts.hardened !== false;
    const globalAlias = !opts || opts.globalAlias !== false;
    if (typeof code !== 'string') {
        return {
            errors: [{ rule: 'invalid-type', message: 'Contract source must be a string', line: null, severity: 'error' }],
            warnings: []
        };
    }

    const errors = [];

    // 1b. Deploy code-size cap. Lives HERE, not only in bin/lint.js, because
    //     this file is the shared source of truth every linting surface goes
    //     through (the SDK's pre-flight and any third-party direct caller), and
    //     a CLI-only copy left those surfaces reporting clean on a contract the
    //     indexer rejects with `invalid: CODE_ENCODING (exceeds max size)`.
    //     Emitted FIRST because the chain checks size BEFORE the syntax gate.
    //     Deliberately NOT a CONSENSUS_RULE: the on-chain verdict for size is
    //     enforced by the indexer/VM ahead of validateSyntax, so adding it to
    //     the blocking set would change nothing on chain and everything about
    //     what error validateSyntax surfaces. Keeping it advisory-to-the-deploy
    //     -path preserves the Move-1 parity invariant byte for byte.
    if (codeSizeBytes(code) > MAX_CODE_SIZE) {
        errors.push({
            rule: 'code-size',
            message: 'code size exceeds limit (' + MAX_CODE_SIZE + ' bytes)',
            line: null,
            severity: 'error'
        });
    }

    // 2. Acorn metering pass. If acorn can't parse it (or it uses post-ES2020
    //    syntax), reject. This also doubles as the blocking parse check.
    try {
        meterCode(code);
    } catch (e) {
        errors.push({
            rule: 'unsupported-syntax',
            message: 'unsupported syntax (ES' + CONTRACT_ECMA_VERSION + ' maximum): ' + e.message,
            line: null,
            severity: 'error'
        });
        // Without a parse there is nothing more to scan deterministically.
        return { errors, warnings: [] };
    }

    // 3. Reserved identifier check. The authoritative ban list is
    //    metering.RESERVED_IDENTIFIERS (frozen against narrowing by
    //    test/determinism/consensus-params.test.js); do not re-enumerate it
    //    here, it has grown and any inline copy drifts. It covers TWO hazard
    //    classes: the allocator metering helpers (ALLOC_HELPERS), where a
    //    reference could bypass or forge SIZE metering, and the call-depth
    //    helpers (DEPTH_HELPERS), where a reference could bypass the
    //    platform-independent recursion bound. Plus __gas itself.
    const reserved = findReservedIdentifier(code);
    if (reserved)
        errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + reserved, line: null, severity: 'error' });

    // 3b. (hardened) CONTRACT_WRAPPER control bindings are reserved too.
    if (hardened) {
        const control = findReservedControlBinding(code);
        if (control)
            errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + control, line: null, severity: 'error' });
    }

    // 4. Banned Math.* check (transcendentals always; hardened: the full
    //    complement of the sandbox SAFE_MATH_MEMBERS whitelist).
    const banned = findBannedMathCalls(code, hardened, globalAlias);
    for (const hit of banned) {
        errors.push({
            rule: 'banned-math',
            message: hit.transcendental
                ? 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                  '; IEEE 754 floating-point transcendentals are non-deterministic ' +
                  'across CPU architectures. Use xchain.math.' + hit.name + '() instead'
                : 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                  '; not part of the deterministic sandbox Math subset ' +
                  '(floor/ceil/round/abs/min/max/sign/trunc/PI/E). Use those members or xchain.math instead',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
    }

    // 4b. (hardened) Banned exponentiation operator. `**` / `**=` invoke the
    //     same Number::exponentiate transcendental the Math.pow ban targets.
    if (hardened) {
        for (const hit of findBannedExponentiation(code)) {
            errors.push({
                rule: 'banned-math',
                message: 'banned operator: ' + hit.op + ' at line ' + hit.line +
                         '; exponentiation is IEEE 754 floating-point (non-deterministic ' +
                         'across CPU architectures). Use xchain.math.pow() instead',
                line: typeof hit.line === 'number' ? hit.line : null,
                severity: 'error'
            });
        }
    }

    // 5. Banned native-DoS literals (BigInt + RegExp). The AST gas meter charges
    //    per __gas() point, not for the cost INSIDE a single native operation, so
    //    BigInt arithmetic and catastrophic regex backtracking burn heavy CPU for
    //    ~0 gas. Literals can only be blocked at the syntax layer.
    const lits = findBannedLiterals(code);
    for (const hit of lits) {
        const advice = hit.kind === 'bigint'
            ? 'BigInt is unmetered native arithmetic; use the xchain.math bignumber API instead'
            : 'regular-expression literals can backtrack catastrophically and are unmetered';
        errors.push({
            rule: 'banned-literal',
            message: 'banned literal: ' + hit.kind + ' literal at line ' + hit.line + '; ' + advice,
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
    }

    // 6. Banned async surface (async functions, await, Promise). The
    //    CONTRACT_WRAPPER invokes exports synchronously, so a pending Promise
    //    returned by an async export resolves (or not) per isolated-vm's
    //    version-dependent microtask-drain timing, which is outside the
    //    consensus-runtime pin: two validators can diverge (success vs timeout,
    //    or differing post-await state). Rejected at deploy like BigInt/RegExp.
    const asyncs = findBannedAsync(code, hardened, globalAlias);
    for (const hit of asyncs) {
        const advice = hit.kind === 'promise'
            ? 'Promise schedules microtasks whose drain timing is isolated-vm version-dependent and unpinned'
            : hit.kind === 'import'
                ? 'dynamic import() evaluates to a Promise; the microtask surface it schedules is nondeterministic across validators'
                : hit.kind === 'await'
                ? 'await resumes after the synchronous contract invocation returns; post-await state writes are nondeterministic across validators'
                : 'async functions return a pending Promise the synchronous CONTRACT_WRAPPER cannot await; their post-await effects are nondeterministic across validators';
        errors.push({
            rule: 'banned-async',
            message: 'banned async surface: ' + hit.kind + ' at line ' + hit.line + ' (' + advice + ')',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
    }

    // 6b. Banned generator surface (function*, generator methods, yield). A
    //     suspended generator frame enters the depth guard but its matching exit
    //     runs only on drain, so undrained generators leak __stackDepth to the 512
    //     cap and trip a spurious deterministic out_of_stack (29912bd8). Rejected
    //     at deploy like the async surface. Pkg 3 bundle (CONSENSUS_VERSION 3).
    for (const hit of findBannedGenerator(code)) {
        const advice = hit.kind === 'yield'
            ? 'yield suspends a generator frame without unwinding the call-depth guard; rewrite without generators'
            : 'a suspended generator frame is not unwound until drained, so undrained generators leak __stackDepth toward the 512 cap and throw a spurious deterministic out_of_stack; use a plain function';
        errors.push({
            rule: 'banned-generator',
            message: 'banned generator surface: ' + hit.kind + ' at line ' + hit.line + ' (' + advice + ')',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
    }

    // 6c. Banned WebAssembly global reference. wasm bodies run native code with no
    //     __gas metering (unmetered native execution) and are a consensus-fork
    //     surface; the sandbox strips the global at the Pkg 3 height flag-day
    //     (75190596). This is the deploy-lint half. Identifier-precise (member
    //     property / object key / shadowed local excluded), so error severity is
    //     sound, unlike the name-only banned-proto-method warnings. Pkg 3 bundle.
    for (const hit of findBannedWasm(code, globalAlias)) {
        errors.push({
            rule: 'banned-wasm',
            message: 'banned global: WebAssembly at line ' + hit.line +
                     '; WebAssembly executes native code that carries no __gas metering (unmetered native execution) ' +
                     'and is a consensus-fork surface. The sandbox removes it, so this is unreachable at runtime',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
    }

    const warnings = findFloatWarnings(code);

    // 7. Sandbox-neutered prototype methods. sandbox.js replaces these with an
    //    undefined, non-writable, non-configurable property, so a call fails
    //    closed with a TypeError on FIRST EXECUTION rather than at deploy. The
    //    linter already blocks RegExp LITERALS (rule 'banned-literal') for the
    //    ReDoS half of this ban; the regex-COERCING methods that survive the
    //    RegExp-global delete are the other half, and only the runtime half
    //    shipped. WARNING severity, never a CONSENSUS_RULE: see the
    //    STRIPPED_PROTO_METHOD_NAMES comment for why a name-only match must
    //    not be allowed to red-line a contract's own .search()/.match().
    for (const hit of findBannedProtoMethods(code)) {
        const advice = hit.regex
            ? 'coerces its argument to a RegExp through the %RegExp% intrinsic, so catastrophic backtracking still runs for ~1 gas'
            : 'its output depends on the host ICU data/version, which varies across validator builds';
        warnings.push({
            rule: 'banned-proto-method',
            message: 'neutered method: .' + hit.name + '() at line ' + hit.line + '; ' + advice +
                     '. The sandbox removes it, so this throws TypeError at runtime',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'warning'
        });
    }

    // 7b. Sandbox-DELETED globals. sandbox.js removes these from the isolate so
    //     every validator computes the same result from the same inputs, which
    //     means a contract that reads one deploys clean and then throws
    //     ReferenceError on its FIRST execution. Only WebAssembly (banned-wasm)
    //     and Promise (banned-async) had a rule; the other 22 names had none, so
    //     the shipped templates' own promise ("a contract CANNOT fetch a URL
    //     directly: the sandbox strips fetch, Date, timers") was unenforced by
    //     any static check. WARNING severity and deliberately NOT a
    //     CONSENSUS_RULE: the sandbox strip is the load-bearing enforcement and
    //     is already unconditional, so promoting this to a deploy-blocking rule
    //     would move on-chain verdicts and needs its own activation epoch.
    for (const hit of findBannedStrippedGlobals(code, globalAlias)) {
        warnings.push({
            rule: 'banned-stripped-global',
            message: 'stripped global: ' + hit.name + ' at line ' + hit.line +
                     '; the sandbox deletes it so every validator computes the same result, ' +
                     'so this throws ReferenceError at runtime. Use the xchain.* gateway instead ' +
                     '(e.g. xchain.attestation.request to read a URL, blockContext.timestamp for time)',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'warning'
        });
    }

    // Move 2: logic-level advisories (crossCallable integrity, gas/footgun heuristics).
    // These run AFTER the consensus checks above and NEVER affect the deploy verdict.
    // validateSyntax blocks only on CONSENSUS_RULES. analyzeContract is fully wrapped so
    // a detector bug can never throw into the deploy path.
    const move2 = analyzeContract(code);
    for (const e of move2.errors) errors.push(e);
    for (const w of move2.warnings) warnings.push(w);

    return { errors, warnings };
}

module.exports = {
    lintSource,
    analyzeContract,
    findBannedMathCalls,
    findBannedLiterals,
    findBannedAsync,
    findBannedGenerator,
    findBannedWasm,
    findBannedExponentiation,
    findBannedProtoMethods,
    findBannedStrippedGlobals,
    findReservedControlBinding,
    codeSizeBytes,
    MAX_CODE_SIZE,
    STRIPPED_PROTO_METHOD_NAMES,
    STRIPPED_GLOBAL_NAMES,
    STRIPPED_GLOBAL_NAMES_MIRROR,
    ADVISORY_STRIPPED_GLOBALS,
    findFloatWarnings,
    CONSENSUS_RULES,
    CONTRACT_ECMA_VERSION,
    SAFE_MATH_MEMBERS,
    RESERVED_CONTROL_BINDINGS
};
