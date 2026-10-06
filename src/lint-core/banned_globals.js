// Banned-global scanners: async surface, generators, WebAssembly and the advisory stripped globals.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { ADVISORY_STRIPPED_GLOBALS } = require('./constants.js');
const { isGlobalObjectRef, staticMemberKey, scopeDeclares } = require('./scope_analysis.js');

/**
 * Scan contract code for the async surface (async functions, await expressions,
 * and Promise references). The CONTRACT_WRAPPER invokes exports SYNCHRONOUSLY:
 * an `async` export returns a pending Promise (JSON.stringify(result) yields
 * "{}"), and whether its post-`await` state writes land depends on isolated-vm's
 * microtask-drain timing inside runSync, a property of the package version that
 * is NOT part of the consensus_runtime pin. A wall-clock interrupt landing
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
 * @param {boolean} [optionalChain=true] - LINT_OPTIONAL_CHAIN consensus flag
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedAsync(code, hardened, aliased, optionalChain) {
    if (hardened === undefined) hardened = true;
    if (aliased === undefined) aliased = true;
    if (optionalChain === undefined) optionalChain = true;
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
            if (!isGlobalObjectRef(node.object, aliased, optionalChain)) return;
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
 * @param {boolean} [optionalChain=true] - LINT_OPTIONAL_CHAIN consensus flag
 * @returns {Array<{line: (number|string)}>}
 */
function findBannedWasm(code, aliased, optionalChain) {
    if (aliased === undefined) aliased = true;
    if (optionalChain === undefined) optionalChain = true;
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
            if (!isGlobalObjectRef(node.object, aliased, optionalChain)) return;
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
 * @param {boolean} [optionalChain=true] - LINT_OPTIONAL_CHAIN consensus flag
 * @returns {Array<{name: string, line: (number|string)}>}
 */
function findBannedStrippedGlobals(code, aliased, names, optionalChain) {
    if (aliased === undefined) aliased = true;
    if (optionalChain === undefined) optionalChain = true;
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
            if (!isGlobalObjectRef(node.object, aliased, optionalChain)) return;
            const key = staticMemberKey(node);
            if (key && wanted.has(key))
                hits.push({ name: key, line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

module.exports = {
    findBannedAsync,
    findBannedGenerator,
    findBannedWasm,
    findBannedStrippedGlobals
};
