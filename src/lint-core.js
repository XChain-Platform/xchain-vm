/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Contract Lint Core (dependency-light, no isolated-vm)
 *
 * The canonical, acorn-only contract validation rules — every deploy-time
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
 * Message strings are BYTE-IDENTICAL to what syntax.js historically emitted —
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
        // Parse failure — validateSyntax's earlier checks would have caught this.
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
 * Scan contract code for non-integer (decimal) number literals — a non-blocking
 * warning that native float arithmetic is being used. Returns structured rules;
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
                            ' — use xchain.math for deterministic arithmetic',
                        line: node.loc ? node.loc.start.line : null
                    });
                }
            }
        });
    } catch (e) {
        // Parse failure — validateSyntax/lintSource report it as a blocking error.
    }
    return warnings;
}

/**
 * Run every acorn-coverable contract rule (steps 2–5 of validateSyntax + the
 * float warnings). The V8 syntax compile (step 1) is NOT here — it needs
 * isolated-vm and stays in syntax.js. Errors are returned in deploy-check order
 * (metering → reserved → banned-math → banned-literal), so errors[0] is exactly
 * the failure validateSyntax would have surfaced first.
 *
 * @param {string} code - Contract source code
 * @returns {{ errors: Array<{rule,message,line}>, warnings: Array<{rule,message,line}> }}
 */
function lintSource(code) {
    if (typeof code !== 'string') {
        return {
            errors: [{ rule: 'invalid-type', message: 'Contract source must be a string', line: null }],
            warnings: []
        };
    }

    const errors = [];

    // 2. Acorn metering pass — if acorn can't parse it (or it uses post-ES2020
    //    syntax), reject. This also doubles as the blocking parse check.
    try {
        meterCode(code);
    } catch (e) {
        errors.push({
            rule: 'unsupported-syntax',
            message: 'unsupported syntax (ES' + CONTRACT_ECMA_VERSION + ' maximum): ' + e.message,
            line: null
        });
        // Without a parse there is nothing more to scan deterministically.
        return { errors, warnings: [] };
    }

    // 3. Reserved identifier check (__gas + the allocator metering helpers
    //    __concat/__tmpl/__arrspread/__objspread — referencing them could
    //    bypass or forge size metering)
    const reserved = findReservedIdentifier(code);
    if (reserved)
        errors.push({ rule: 'reserved-identifier', message: 'reserved identifier: ' + reserved, line: null });

    // 4. Banned transcendental Math.* check
    const banned = findBannedMathCalls(code);
    for (const hit of banned) {
        errors.push({
            rule: 'banned-math',
            message: 'banned API: Math.' + hit.name + ' at line ' + hit.line +
                     ' — IEEE 754 floating-point transcendentals are non-deterministic ' +
                     'across CPU architectures; use xchain.math.' + hit.name + '() instead',
            line: typeof hit.line === 'number' ? hit.line : null
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
            message: 'banned literal: ' + hit.kind + ' literal at line ' + hit.line + ' — ' + advice,
            line: typeof hit.line === 'number' ? hit.line : null
        });
    }

    return { errors, warnings: findFloatWarnings(code) };
}

module.exports = {
    lintSource,
    findBannedMathCalls,
    findBannedLiterals,
    findFloatWarnings,
    CONTRACT_ECMA_VERSION
};
