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
 * XChain VM: execute-time source lint
 *
 * Re-lints the stored contract source against the bans active at the
 * executing block and bills the lint charge before the verdict cache.
 ********************************************************************/
// @ts-nocheck

const { GasExhaustedError } = require('../../errors.js');
const { isLintOptionalChainActive } = require('../lint_optional_chain_heights.js');
const { isLintBannedWithActive } = require('../lint_banned_with_heights.js');
const { isLintDestructureActive } = require('../lint_destructure_heights.js');
const {
    isAsyncSurfaceActive, isLintHardeningActive, isRestPatternMeterActive,
    isPkg3SandboxActive, isLintGlobalAliasActive, EXEC_LINT_GAS_BYTES_PER_UNIT,
    isExecLintActive,
} = require('./activations.js');

/**
 * The eight flags are resolved by the SAME predicates the rest of the VM already
 * uses, which are the execution-side twins of the flags the indexer threads into
 * deploy/index.js validateSyntax, so the execute-time verdict agrees with what a deploy
 * in this block would have produced:
 *   banned-async                    -> isAsyncSurfaceActive   (block time)
 *   VM_LINT_HARDENING rule set      -> isLintHardeningActive  (block time)
 *   banned-generator + banned-wasm  -> isPkg3SandboxActive    (per-coin height)
 *   LINT_GLOBAL_ALIAS refinement    -> isLintGlobalAliasActive (per-coin height)
 *   banned-rest (unmeterable rest)  -> isRestPatternMeterActive (block time)
 *   LINT_OPTIONAL_CHAIN refinement  -> isLintOptionalChainActive (per-coin height)
 *   banned-with                     -> isLintBannedWithActive (per-coin height)
 *   LINT_DESTRUCTURE refinement     -> isLintDestructureActive (per-coin height)
 * The last two travel after codeHash as explicit arguments.
 *
 * @returns {object|null} an error result when the lint gate refuses the
 *   execution, null when execution may proceed.
 */
function checkExecLint(vm, opts, gasTracker, emissionCollector, codeStr, codeBytes, codeHash, coin, height) {
    // Re-run the consensus source lint over the STORED code against the bans active at
    // THIS block, so a contract accepted before a ban activates stops executing banned
    // syntax once that ban is live. Deploy-time validation alone cannot do this: it ran
    // under the rule set of the deploy block and its verdict was final.
    //
    // The whole check rides its own per-coin height gate (isExecLintActive), armed at
    // genesis on every named network: below it, which now means only a chain the
    // resolver cannot place, nothing is charged and nothing is checked, so the
    // pre-activation path stays byte-identical, gasUsed included.
    if (isExecLintActive(opts.network, coin, height)) {
        const __lintBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
        // Charge FIRST and unconditionally (before the verdict cache is consulted), so a
        // warm node and a cold node bill identical gas for the identical execution and
        // the cache stays invisible to consensus. Source-length-derived, so it is a
        // deterministic function of the stored code.
        const __lintUnits = Math.max(1, Math.ceil(codeBytes / EXEC_LINT_GAS_BYTES_PER_UNIT));
        try {
            gasTracker.charge(vm.gasSchedule.VM_COMPUTATION * __lintUnits);
        } catch (e) {
            if (e instanceof GasExhaustedError) {
                // Same clamp the general out_of_gas path applies: bill at most the
                // ceiling so the fee can never exceed the caller's committed budget.
                return vm.errorResult(gasTracker, emissionCollector,
                    'out_of_gas: used ' + e.used + ' of ' + e.ceiling, gasTracker.ceiling);
            }
            throw e;
        }
        const __lintVerdict = vm.getLintVerdict(
            codeStr,
            isAsyncSurfaceActive(opts.network, __lintBlockTime),
            isLintHardeningActive(opts.network, __lintBlockTime),
            isPkg3SandboxActive(opts.network, coin, height),
            isLintGlobalAliasActive(opts.network, coin, height),
            isRestPatternMeterActive(opts.network, __lintBlockTime),
            isLintOptionalChainActive(opts.network, coin, height),
            codeHash,
            isLintBannedWithActive(opts.network, coin, height),
            isLintDestructureActive(opts.network, coin, height)
        );
        if (!__lintVerdict.valid) {
            // 'error:' is one of the frozen STATUS_ERROR_PREFIXES (consensus-runtime.js);
            // the indexer collapses it to the generic failure token. The lint message is
            // deterministic and path-free, so it is safe to surface verbatim.
            return vm.errorResult(gasTracker, emissionCollector,
                'error: banned syntax: ' + __lintVerdict.error);
        }
    }
    return null;
}

module.exports = { checkExecLint };
