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
 * XChain VM — Syntax Validation
 *
 * Deploy-time validation: V8 syntax check, acorn metering pass,
 * reserved identifier check, and float warnings.
 ********************************************************************/

const ivm   = require('isolated-vm');
const acorn = require('acorn');
const walk  = require('acorn-walk');
const { meterCode, hasGasIdentifier } = require('./metering.js');

/**
 * Validate contract code syntax before deployment.
 * Runs four blocking checks in order:
 * 1. V8 syntax check (compileScriptSync in throwaway isolate)
 * 2. Acorn metering pass (ensures acorn can parse it — supported syntax = min(V8, acorn))
 * 3. Reserved identifier check (__gas)
 * 4. Banned transcendental Math.* check (Math.sqrt/pow/log/log2/log10)
 *
 * @param {string} code - Contract source code
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(code) {
    // 1. V8 syntax check
    let testIsolate;
    try {
        testIsolate = new ivm.Isolate({ memoryLimit: 8 });
        testIsolate.compileScriptSync(code);
    } catch (e) {
        return { valid: false, error: 'syntax error: ' + e.message };
    } finally {
        try { if (testIsolate) testIsolate.dispose(); } catch (e) {}
    }

    // 2. Acorn metering pass — if acorn can't parse it, reject
    try {
        meterCode(code);
    } catch (e) {
        return { valid: false, error: 'unsupported syntax (ES2020 maximum): ' + e.message };
    }

    // 3. Reserved identifier check
    if (hasGasIdentifier(code))
        return { valid: false, error: 'reserved identifier: __gas' };

    // 4. Banned transcendental Math.* check
    const banned = findBannedMathCalls(code);
    if (banned.length > 0) {
        const first = banned[0];
        return {
            valid: false,
            error: 'banned API: Math.' + first.name + ' at line ' + first.line +
                   ' — IEEE 754 floating-point transcendentals are non-deterministic ' +
                   'across CPU architectures; use xchain.math.' + first.name + '() instead'
        };
    }

    // 5. Banned native-DoS literals (BigInt + RegExp).
    // The AST gas meter charges per __gas() point, not for the cost INSIDE a single
    // native operation, so BigInt arithmetic (`2n ** 5000000n`) and catastrophic regex
    // backtracking (`/(a+)+$/`) burn heavy CPU for ~0 gas — a block packed with such
    // EXECUTEs can exceed the indexer's block watchdog and halt the chain. The BigInt
    // global and RegExp constructor are stripped at runtime; literals can only be
    // blocked at the syntax layer.
    const lits = findBannedLiterals(code);
    if (lits.length > 0) {
        const first = lits[0];
        const advice = first.kind === 'bigint'
            ? 'BigInt is unmetered native arithmetic; use the xchain.math bignumber API instead'
            : 'regular-expression literals can backtrack catastrophically and are unmetered';
        return {
            valid: false,
            error: 'banned literal: ' + first.kind + ' literal at line ' + first.line +
                   ' — ' + advice
        };
    }

    return { valid: true };
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
        ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script', locations: true });
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
            ecmaVersion: 2020,
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
 * Scan contract code for patterns suggesting native float arithmetic.
 * Non-blocking warning — does not reject the contract.
 *
 * @param {string} code - Contract source code
 * @returns {string[]} Array of warning messages
 */
function checkFloatWarnings(code) {
    const warnings = [];
    try {
        const ast = acorn.parse(code, {
            ecmaVersion: 2020,
            sourceType: 'script',
            locations: true
        });
        walk.simple(ast, {
            Literal(node) {
                if (typeof node.value === 'number' && !Number.isInteger(node.value)) {
                    const line = node.loc ? node.loc.start.line : '?';
                    warnings.push(
                        'WARNING: decimal number literal (' + node.value +
                        ') detected at line ' + line +
                        ' — use xchain.math for deterministic arithmetic'
                    );
                }
            }
        });
    } catch (e) {
        // Parse failure — validateSyntax would have caught this
    }
    return warnings;
}

module.exports = { validateSyntax, checkFloatWarnings, findBannedMathCalls, findBannedLiterals };
