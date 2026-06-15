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
 * Deploy-time validation: V8 syntax check (the only step needing
 * isolated-vm), then the acorn-coverable rules — metering pass, reserved
 * identifiers, banned Math.*, banned literals, and float warnings — which
 * live in the dependency-light, vendorable ./lint-core.js. Keeping the
 * rules in one place guarantees the deploy path and the SDK/CLI linter
 * never diverge.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');
const { lintSource, findFloatWarnings, findBannedMathCalls, findBannedLiterals, CONSENSUS_RULES } = require('./lint-core.js');

/**
 * Validate contract code syntax before deployment.
 * Runs five blocking checks in order:
 * 1. V8 syntax check (compileScriptSync in throwaway isolate) — needs isolated-vm
 * 2. Acorn metering pass (supported syntax = min(V8, acorn))
 * 3. Reserved identifier check (__gas + allocator metering helpers)
 * 4. Banned transcendental Math.* check (Math.sqrt/pow/log/log2/log10)
 * 5. Banned native-DoS literals (BigInt + RegExp)
 *
 * Steps 2–5 are delegated to lint-core.lintSource(); the returned error
 * messages are byte-identical to this function's historical output, so the
 * deploy-path verdict (and its on-chain execution record) is unchanged.
 *
 * @param {string} code - Contract source code
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(code) {
    // 1. V8 syntax check (the only step that requires isolated-vm)
    let testIsolate;
    try {
        testIsolate = new ivm.Isolate({ memoryLimit: 8 });
        testIsolate.compileScriptSync(code);
    } catch (e) {
        return { valid: false, error: 'syntax error: ' + e.message };
    } finally {
        try { if (testIsolate) testIsolate.dispose(); } catch (e) {}
    }

    // 2–5. Acorn-coverable rules (shared canonical source of truth). Block ONLY on
    // consensus rules — lintSource also returns Move-2 advisory findings, which are
    // author-facing signal and must never change the on-chain deploy verdict.
    const blocking = lintSource(code).errors.filter((e) => CONSENSUS_RULES.has(e.rule));
    if (blocking.length > 0)
        return { valid: false, error: blocking[0].message };

    return { valid: true };
}

/**
 * Scan contract code for patterns suggesting native float arithmetic.
 * Non-blocking warning — does not reject the contract.
 *
 * @param {string} code - Contract source code
 * @returns {string[]} Array of warning messages
 */
function checkFloatWarnings(code) {
    return findFloatWarnings(code).map((w) => w.message);
}

// findBannedMathCalls / findBannedLiterals moved to lint-core.js; re-exported
// here so existing callers of syntax.js keep working unchanged.
module.exports = { validateSyntax, checkFloatWarnings, findBannedMathCalls, findBannedLiterals };
