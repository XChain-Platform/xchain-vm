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
 * XChain VM: Main Entry Point
 *
 * The XChainVM class is the public API for the VM runtime.
 * It creates V8 isolates, injects the gateway, meters code,
 * executes contracts, and collects results.
 *
 * Usage:
 *   const vm = new XChainVM({ gasSchedule, gasCeiling, limits });
 *   const result = await vm.execute({ code, state, method, params, ... });
 ********************************************************************/
// @ts-nocheck

const IsolateManager    = require('./isolate.js');
const ActionValidator   = require('./validator.js');
const GasTracker         = require('./gas.js');
// Consensus wall-clock budget per execution (see consensus-wall-clock.js). The
// per-node limits.maxCpuTimeMs binds ungated executions only.
const { resolveWallClockBudgetMs } = require('./consensus-wall-clock.js');
// The entry keeps the class (constructor and the consensus wall-clock resolver);
// the prototype methods, the harness prelude, the activation carriers and the
// public statics live in named parts under ./index/ and ./index/runtime/ and are
// installed here so the public surface (constructor, prototype, statics) is the
// one this file always exported.
const { installMethods } = require('./index/install_methods.js');
const blockLifecycleMethods = require('./index/block_lifecycle.js');
const lintAndMeteringMethods = require('./index/lint_and_metering.js');
const gatewayInjectionMethods = require('./index/gateway_injection.js');
const errorResultMethods = require('./index/error_results.js');
const manifestMethods = require('./index/manifest.js');
const executeMethods = require('./index/runtime/execute.js');
const classifyErrorMethods = require('./index/runtime/classify_error.js');
const { resolveLimits } = require('./index/runtime/limits_defaults.js');
const { initCaches } = require('./index/runtime/vm_caches.js');
const { assertExecutionMode } = require('./index/runtime/execution_mode.js');
const {
    isConsensusWallClockActive,
    BIGINT_SURFACE_STRIP_ACTIVATION,
    isBigIntSurfaceStripActive,
} = require('./index/runtime/activations.js');
const { attachStatics } = require('./index/runtime/public_exports.js');
const { setTimeoutLog } = require('./index/runtime/timeout_log.js');
const {
    LINT_BANNED_WITH_ACTIVATION,
    isLintBannedWithActive,
} = require('./index/lint_banned_with_heights.js');
const {
    LINT_DESTRUCTURE_ACTIVATION,
    isLintDestructureActive,
} = require('./index/lint_destructure_heights.js');

class XChainVM {
    /**
     * @param {object} config
     * @param {object} config.gasSchedule - Gas costs for each operation
     * @param {number} config.gasCeiling  - Maximum gas per execution
     * @param {object} config.limits      - Resource limits
     */
    constructor(config) {
        this.gasSchedule = config.gasSchedule;
        this.gasCeiling  = config.gasCeiling || 1000000;
        this.limits      = resolveLimits(config.limits);
        this.isolateManager = new IsolateManager(this.limits);
        this.actionValidator = new ActionValidator();
        initCaches(this);

        // Execution mode.
        //   'in-process' (default): run the isolate in THIS process. Fast; used
        //       by the whole test/bench suite and by syntax validation.
        //   'subprocess': run every execution in a forked child via ProcessExecutor,
        //       so a contract that aborts V8 (process-wide SIGABRT, e.g. a bulk
        //       allocation that bypasses the isolate memory limit) crashes only the
        //       child, never the host. PRODUCTION (the indexer) MUST use this.
        // Default is in-process so existing in-process callers (which pass closure
        // accessors that can't cross IPC) keep working unchanged; the indexer opts
        // into 'subprocess' explicitly.
        assertExecutionMode(config.execution);
        if (config.execution === undefined && !XChainVM._warnedImplicitInProcess) {
            // Loud once per process: an embedder that never chose a mode is
            // running without SIGABRT containment, which is only safe for
            // tests/tooling. Choosing 'in-process' explicitly acknowledges the
            // trade-off and silences this.
            XChainVM._warnedImplicitInProcess = true;
            console.warn("XChainVM: no execution mode configured, defaulting to 'in-process', " +
                "which has NO host-crash (SIGABRT) containment. Production embedders must pass " +
                "execution: 'subprocess'; pass execution: 'in-process' to acknowledge and silence this.");
        }
        this.execution = config.execution || 'in-process';
        this._executor = null;
        if (this.execution === 'subprocess') {
            // Lazy require to avoid loading child_process for in-process callers.
            const ProcessExecutor = require('./process-executor.js');
            this._executor = new ProcessExecutor(config);
        }
    }

    /**
     * The wall-clock budget THIS execution runs against, in milliseconds.
     *
     * Consensus quantity at/after the flag-day: every validator resolves
     * CONSENSUS_MAX_WALL_MS here regardless of its own limits.maxCpuTimeMs, so
     * the wall-clock net that terminates a shape whose wall time outruns its gas
     * fires at the same budget on every node (identical status, identical
     * ceiling-clamped gasUsed). Below the gate the per-node knob is returned
     * verbatim, so historical blocks replay exactly as they were indexed and
     * non-consensus callers (benches, fuzzing, the toolkit simulator) keep their
     * tight budgets. Used both by execute() (the isolate timeout) and by
     * classifyError() (the elapsed-time corroboration threshold), so the two
     * can never disagree about what "timed out" means.
     */
    wallClockBudgetMs(opts) {
        const blockTime = opts && opts.blockContext && Number(opts.blockContext.timestamp);
        return resolveWallClockBudgetMs(
            isConsensusWallClockActive(opts && opts.network, blockTime),
            this.limits.maxCpuTimeMs);
    }
}

// Put the part methods back on the prototype with class-method flags (not
// enumerable). The key set and every descriptor match the class body's;
// only the prototype's property order differs, which nothing reads.
installMethods(
    XChainVM.prototype,
    blockLifecycleMethods,
    lintAndMeteringMethods,
    gatewayInjectionMethods,
    errorResultMethods,
    manifestMethods,
    executeMethods,
    classifyErrorMethods
);

module.exports = XChainVM;
setTimeoutLog((message) => console.error(message));
attachStatics(XChainVM);
const heightGateExports = Object.create(Object.getPrototypeOf(XChainVM), {
    LINT_BANNED_WITH_ACTIVATION: { value: LINT_BANNED_WITH_ACTIVATION, enumerable: true },
    isLintBannedWithActive: { value: isLintBannedWithActive, enumerable: true },
    LINT_DESTRUCTURE_ACTIVATION: { value: LINT_DESTRUCTURE_ACTIVATION, enumerable: true },
    isLintDestructureActive: { value: isLintDestructureActive, enumerable: true },
    BIGINT_SURFACE_STRIP_ACTIVATION: { value: BIGINT_SURFACE_STRIP_ACTIVATION, enumerable: true },
    isBigIntSurfaceStripActive: { value: isBigIntSurfaceStripActive, enumerable: true },
});
Object.setPrototypeOf(XChainVM, heightGateExports);
module.exports.GAS_CEILING_SUCCESS_ACTIVATION = GasTracker.GAS_CEILING_SUCCESS_ACTIVATION;
module.exports.isGasCeilingSuccessActive = GasTracker.isGasCeilingSuccessActive;
