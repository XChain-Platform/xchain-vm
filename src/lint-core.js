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

/**
 * Scan contract code for references to banned transcendental Math members
 * (Math.sqrt / Math.pow / Math.log / Math.log2 / Math.log10), in both dotted
 * (Math.pow) and computed-string (Math['pow']) forms.
 *
 * @param {string} code - Contract source code
 * @returns {Array<{name: string, line: (number|string)}>}
 */
function findBannedMathCalls(code) {
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
            if (!node.object || node.object.type !== 'Identifier' || node.object.name !== 'Math')
                return;
            let member = null;
            if (!node.computed && node.property && node.property.type === 'Identifier') {
                member = node.property.name;                 // Math.pow
            } else if (node.computed && node.property && node.property.type === 'Literal'
                       && typeof node.property.value === 'string') {
                member = node.property.value;                // Math['pow']
            }
            if (member && BANNED_MATH_MEMBERS.has(member)) {
                hits.push({ name: member, line: node.loc ? node.loc.start.line : '?' });
            }
        }
    });
    return hits;
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
 * @param {string} code - Contract source code
 * @returns {Array<{kind: string, line: (number|string)}>}
 */
function findBannedAsync(code) {
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
            const parent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
            if (parent) {
                if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
            }
            hits.push({ kind: 'promise', line: node.loc ? node.loc.start.line : '?' });
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

// ─────────────────────────────────────────────────────────────────────────────
// Move 2: logic-level lint rules (advisory; NEVER deploy-blocking).
//
// CONSENSUS_RULES are the only findings the on-chain deploy validator
// (validateSyntax -> xchain-indexer/deploy.js) acts on. Everything analyzeContract
// adds is author-facing signal for the SDK linter and the CLI; it must not change
// what the chain accepts, or the Move-1 deploy-parity invariant breaks. Keep this
// set in lockstep with the error-severity rules emitted above lintSource's Move-2
// section.
// ─────────────────────────────────────────────────────────────────────────────
const CONSENSUS_RULES = new Set([
    'invalid-type',
    'unsupported-syntax',
    'reserved-identifier',
    'banned-math',
    'banned-literal',
    'banned-async'
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
 * banned-math -> banned-literal) FIRST, so errors[0] (filtered to CONSENSUS_RULES)
 * is exactly the failure validateSyntax surfaces. Move-2 findings (advisory) are
 * appended after and never affect the deploy verdict.
 *
 * @param {string} code - Contract source code
 * @returns {{ errors: Array<{rule,message,line,severity}>, warnings: Array<{rule,message,line,severity}> }}
 */
function lintSource(code) {
    if (typeof code !== 'string') {
        return {
            errors: [{ rule: 'invalid-type', message: 'Contract source must be a string', line: null, severity: 'error' }],
            warnings: []
        };
    }

    const errors = [];

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

    // 3. Reserved identifier check (__gas + the allocator metering helpers
    //    __concat/__tmpl/__arrspread/__objspread). Referencing them could
    //    bypass or forge size metering.
    const reserved = findReservedIdentifier(code);
    if (reserved)
        errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + reserved, line: null, severity: 'error' });

    // 4. Banned transcendental Math.* check
    const banned = findBannedMathCalls(code);
    for (const hit of banned) {
        errors.push({
            rule: 'banned-math',
            message: 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                     '; IEEE 754 floating-point transcendentals are non-deterministic ' +
                     'across CPU architectures. Use xchain.math.' + hit.name + '() instead',
            line: typeof hit.line === 'number' ? hit.line : null,
            severity: 'error'
        });
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
    const asyncs = findBannedAsync(code);
    for (const hit of asyncs) {
        const advice = hit.kind === 'promise'
            ? 'Promise schedules microtasks whose drain timing is isolated-vm version-dependent and unpinned'
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

    const warnings = findFloatWarnings(code);

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
    findFloatWarnings,
    CONSENSUS_RULES,
    CONTRACT_ECMA_VERSION
};
