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
 * XChain VM: Syntax Validation
 *
 * Deploy-time validation: V8 syntax check (the only step needing
 * isolated-vm), then the acorn-coverable rules (metering pass, reserved
 * identifiers, banned Math.*, banned literals, and float warnings) which
 * live in the dependency-light, vendorable ./lint-core.js. Keeping the
 * rules in one place guarantees the deploy path and the SDK/CLI linter
 * never diverge.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');
const { lintSource, findFloatWarnings, findBannedMathCalls, findBannedLiterals, findBannedAsync, CONSENSUS_RULES } = require('./lint-core.js');

/**
 * Validate contract code syntax before deployment. Runs a V8 syntax check
 * (the only step needing isolated-vm) then the acorn-coverable consensus rules
 * via lint-core.lintSource(); error messages are byte-identical to the
 * historical output, so the on-chain deploy verdict is unchanged.
 *
 * @param {string} code - Contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.enforceBannedAsync=true] - whether the 'banned-async'
 *        rule (async/await/Promise) is deploy-blocking. CONSENSUS-GATED: the
 *        indexer passes the resolved VM_BANNED_ASYNC flag-day activation
 *        (deploy.js) so that BELOW the flag day an async/Promise DEPLOY resolves
 *        exactly as it did pre-activation (accepted), and a from-genesis replay
 *        reproduces the historical verdict. Defaults to true so author-facing
 *        callers (the SDK/CLI linter, unit tests) always see the rule.
 * @param {boolean} [opts.enforceLintHardening=true] - whether the
 *        VM_LINT_HARDENING rule set (exponentiation ban, reserved control
 *        bindings, SAFE_MATH complement, dynamic import(), shorthand
 *        { Promise }, shadowed-local Promise relaxation) applies. CONSENSUS-
 *        GATED identically to enforceBannedAsync: the indexer passes the
 *        resolved VM_LINT_HARDENING activation (deploy.js) so a from-genesis
 *        replay reproduces historical verdicts. Defaults to true.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(code, opts) {
    const enforceBannedAsync    = !opts || opts.enforceBannedAsync !== false;
    const enforceLintHardening  = !opts || opts.enforceLintHardening !== false;

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

    // 2-5. Acorn-coverable consensus rules. Block ONLY on consensus rules;
    // lintSource also returns Move-2 advisory findings, which must never change
    // the on-chain verdict. When banned-async is not yet flag-day-active, drop
    // that rule from the blocking set (pre-activation parity).
    const blocking = lintSource(code, { hardened: enforceLintHardening }).errors.filter((e) => {
        if (e.rule === 'banned-async' && !enforceBannedAsync) return false;
        return CONSENSUS_RULES.has(e.rule);
    });
    if (blocking.length > 0)
        return { valid: false, error: blocking[0].message };

    return { valid: true };
}

/**
 * Scan contract code for patterns suggesting native float arithmetic.
 * Non-blocking warning; does not reject the contract.
 *
 * @param {string} code - Contract source code
 * @returns {string[]} Array of warning messages
 */
function checkFloatWarnings(code) {
    return findFloatWarnings(code).map((w) => w.message);
}

// findBannedMathCalls / findBannedLiterals moved to lint-core.js; re-exported
// here so existing callers of syntax.js keep working unchanged.
module.exports = { validateSyntax, checkFloatWarnings, findBannedMathCalls, findBannedLiterals, findBannedAsync };
