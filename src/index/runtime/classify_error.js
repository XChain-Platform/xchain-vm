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
 * XChain VM: error classification
 *
 * XChainVM.classifyError: maps an execution error onto the frozen status
 * prefixes. Installed on the XChainVM prototype by the entry (../../index.js).
 ********************************************************************/
// @ts-nocheck

const { ContractRevertError, GasExhaustedError, HostFaultError } = require('../../errors.js');
const { isLintHardeningActive } = require('./activations.js');
const { logTimeout } = require('./timeout_log.js');

module.exports = {
    /**
     * Classify an execution error and return the appropriate result.
     *
     * The error STRING prefixes emitted here (revert/out_of_gas/timeout/
     * out_of_memory/out_of_stack/error; out_of_resource from process_executor)
     * are the frozen STATUS_ERROR_PREFIXES in consensus-runtime.js. The indexer
     * collapses them into CONSENSUS_STATUS_TOKENS (utility.vmFailureStatus).
     * Changing a prefix is a consensus change; guarded by the consensus-params
     * tests in both repos.
     */
    classifyError(error, gasTracker, emissionCollector, opts, execContext, hostSignals) {
        // A host fault is not a contract outcome and has no classification here:
        // laundering one into a frozen status prefix commits a validator-local
        // verdict for an execution every healthy peer completes. Re-throw so the
        // caller halts and retries (faultGuard.rethrowIfInfraFault). The test is
        // `instanceof`, never a message or a `code` read off the error, because
        // an error crossing the isolate boundary arrives as a plain host-side
        // Error built from contract-controlled text and could otherwise be
        // spoofed into a halt.
        if (error instanceof HostFaultError) throw error;
        if (error instanceof ContractRevertError) {
            return this.errorResult(gasTracker, emissionCollector, 'revert: ' + error.message);
        }
        if (error instanceof GasExhaustedError) {
            // Clamp the consensus-visible gasUsed to the ceiling. A single charge can
            // overshoot the ceiling by a lot (the allocation wrappers charge the full
            // requested size, e.g. 1e8 for Array(1e8).fill), but a contract allotted
            // `ceiling` gas must never be billed beyond it, otherwise fee = gasUsed *
            // GAS_PRICE could exceed the caller's committed budget and drive balances
            // negative. The raw `used` stays in the (un-hashed) error message for debugging.
            // Clamp target is the TRACKER's ceiling (= the per-call reservation for a
            // cross-contract callee), never the constructor ceiling: a nested callee
            // billed at 1M against a 50k reservation would diverge the refund math.
            return this.errorResult(gasTracker, emissionCollector,
                'out_of_gas: used ' + error.used + ' of ' + error.ceiling, gasTracker.ceiling);
        }
        // Detect typed errors that lost their class crossing the isolate boundary.
        // Only trust \x03-prefixed messages when the tracker/context confirms the classification,
        // to prevent contracts from spoofing error types via throw new Error('\x03GAS:...').
        const msg = error.message || '';
        if (msg.charCodeAt(0) === 0x03) {
            const payload = msg.substring(1);
            if (payload.startsWith('REVERT:') && execContext && execContext.reverted) {
                // Use the stored revert reason from execContext, NOT the error message,
                // to prevent spoofing via try { xchain.revert('real') } catch(e) {}
                // followed by throw new Error('\x03REVERT:fake')
                const reason = execContext.revertReason || payload.substring(7);
                return this.errorResult(gasTracker, emissionCollector, 'revert: ' + reason);
            }
            if (payload.startsWith('GAS:') && gasTracker.used > gasTracker.ceiling) {
                return this.errorResult(gasTracker, emissionCollector,
                    'out_of_gas: used ' + gasTracker.used + ' of ' + gasTracker.ceiling, gasTracker.ceiling);
            }
        }
        // Non-deterministic resource terminations: wall-clock timeout, isolate
        // memory limit, and native stack overflow all
        // fire at machine-/GC-/stack-depth-dependent points, so gasTracker.getUsed()
        // at that instant DIFFERS across validators. Since the indexer computes
        // fee = gasUsed * GAS_PRICE (consensus-critical), a nondeterministic gasUsed
        // would diverge fees → fork. We therefore CLAMP gasUsed to the gas ceiling
        // for every non-gas, non-revert resource termination: the contract provably
        // consumed the maximum allowed resources, and the ceiling is identical on
        // every node. This is the deterministic, fork-safe charge.
        // e9c3a80b (VM_LINT_HARDENING-gated): the three resource branches below
        // historically matched attacker-authorable MESSAGE SUBSTRINGS and then
        // clamped gasUsed to the ceiling, so a contract could pick its collapsed
        // status token (timeout/out_of_memory/out_of_stack) via `throw new
        // Error('...disposed...')` and force gasUsed=ceiling, unlike the REVERT/
        // GAS paths which corroborate against host state. Post-gate each branch
        // additionally requires a HOST-OBSERVED signal (real elapsed wall clock,
        // the isolate's real disposed flag, or the error's native class/exact
        // deterministic guard message); an uncorroborated match falls through to
        // the generic sanitized 'error:' classification with the real gasUsed
        // (deterministic: the throw itself is deterministic contract behavior).
        // Pre-gate (and whenever signals are unavailable) the legacy message-only
        // classification is preserved byte-for-byte, so a from-genesis replay
        // reproduces historical statuses.
        const __clsBlockTime = opts && opts.blockContext && Number(opts.blockContext.timestamp);
        const __corroborate  = isLintHardeningActive(opts && opts.network, __clsBlockTime) && !!hostSignals;
        const __isolate      = (hostSignals && typeof hostSignals.getIsolate === 'function')
            ? hostSignals.getIsolate() : null;
        const __isolateDisposed = !!(__isolate && __isolate.isDisposed);
        if (msg.includes('Script execution timed out') || msg.includes('disposed')) {
            // Corroborate against the CONSENSUS wall-clock budget this execution
            // actually ran under (carried on hostSignals), not the node's own
            // maxCpuTimeMs: with the bound active the isolate stops at the
            // protocol budget, so a node whose knob is looser than the budget
            // would otherwise refuse to recognise its own timeout and would
            // classify it as a generic error with an unclamped gasUsed - the very
            // per-node divergence the bound exists to remove. Falls back to
            // re-resolving from opts when a caller (a unit test, a direct
            // classifyError call) supplied signals without a budget.
            const __wallBudgetMs = (hostSignals && hostSignals.wallBudgetMs != null)
                ? hostSignals.wallBudgetMs : this.wallClockBudgetMs(opts);
            const legit = !__corroborate
                || __isolateDisposed
                || (hostSignals.runStartNs != null &&
                    (process.hrtime.bigint() - hostSignals.runStartNs) >= BigInt(__wallBudgetMs) * 1000000n);
            if (legit) {
                // Wall-clock timeout (consensus risk). Log at ERROR level.
                logTimeout('[VM TIMEOUT] Wall-clock safety net triggered. ' +
                    (opts ? 'contract=' + opts.contractAddress + ' method=' + opts.method : ''));
                return this.errorResult(gasTracker, emissionCollector,
                    'timeout: wall-clock safety net triggered', gasTracker.ceiling);
            }
        }
        // Memory limit. Post-gate, corroborated by the isolate's real disposed
        // flag (a catastrophic isolate OOM disposes the isolate).
        else if (msg.includes('out of memory') || msg.includes('Array buffer allocation failed')) {
            if (!__corroborate || __isolateDisposed) {
                return this.errorResult(gasTracker, emissionCollector,
                    'out_of_memory: isolate memory limit exceeded', gasTracker.ceiling);
            }
        }
        // Native stack overflow (e.g. deep/infinite recursion). The V8 stack-depth
        // limit varies by architecture and V8 build, so gasUsed here is also
        // platform-dependent → clamp to the ceiling with a deterministic message.
        // Post-gate, corroborated by the error's native RangeError class (a real
        // V8 overflow) or the recursion/native-depth guard's exact deterministic
        // fault message; a plain Error carrying a lookalike substring falls
        // through to the generic classification.
        else if (msg.includes('Maximum call stack size exceeded') || msg.includes('call stack')) {
            const legit = !__corroborate
                || (error instanceof RangeError) || (error && error.name === 'RangeError')
                || msg === 'maximum call stack depth exceeded';
            if (legit) {
                return this.errorResult(gasTracker, emissionCollector,
                    'out_of_stack: maximum call depth exceeded', gasTracker.ceiling);
            }
        }
        // Generic contract error: sanitize to prevent information leakage (RISK-15).
        // Strip stack traces, file paths, and internal details.
        return this.errorResult(gasTracker, emissionCollector, 'error: ' + this.sanitizeError(msg));
    },
};
