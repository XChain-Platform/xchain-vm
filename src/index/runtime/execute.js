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
 * XChain VM: execution pipeline
 *
 * XChainVM.execute: validates and meters the contract, builds the isolate
 * and gateway, runs the method and shapes the result. Installed on the
 * XChainVM prototype by the entry (../../index.js).
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');

const GasTracker        = require('../../gas.js');
const { effectiveCeiling } = require('../../gas.js');
const StateManager      = require('../../state.js');
const EmissionCollector = require('../../collector.js');
const { buildGateway } = require('../../gateway.js');
const sandbox = require('../../sandbox.js');
const { HostFaultError } = require('../../errors.js');
const { resolveAccessors, isAccessorOwnKeyActive } = require('../../readonly-accessors.js');
const {
    BINARY_ALLOC_GATE_BLOCK_TIME, isAsyncSurfaceActive,
    isLintHardeningActive, isStateKeyNulRejectActive, isStateKeyTypeNormalizeActive,
    isMeteringEvalOrderActive, isCallSpreadMeterActive, isRestPatternMeterActive,
    pkg3CoinFromAddress, isPkg3SandboxActive, isBigIntSurfaceStripActive,
} = require('./activations.js');
const { checkExecLint } = require('./exec_lint.js');
const { buildGatewayOptions } = require('./gateway_options.js');
const { makeGasReference } = require('./gas_reference.js');
const { injectExecutionGlobals } = require('./isolate_globals.js');
const { buildContractSource, extractReturnValue } = require('./contract_io.js');

module.exports = {
    /**
     * Execute a smart contract method.
     * @param {object} opts
     * @param {string} opts.code             - Contract source code
     * @param {object} opts.state            - Current contract state { key: value }
     * @param {string} opts.method           - Method name to call
     * @param {string[]} opts.params         - Method parameters
     * @param {string} opts.caller           - Address that sent the EXECUTE tx
     * @param {string} opts.contractAddress  - Contract derived address
     * @param {object} opts.blockContext     - { height, timestamp, hash }
     * @param {object} [opts.balances]       - Address balances for getBalance()
     * @param {object} [opts.tokenInfo]      - Token info for getTokenInfo()
     * @param {object} [opts.oracleData]     - Oracle accessor
     * @param {object} [opts.crossChainData] - Cross-chain accessor
     * @param {number} [opts.contractIndex]  - For compilation cache key
     * @param {object} [opts.providerDeadlines] - { [providerId]: maxDeadlineBlocks } map; enforces
     *                                            the per-provider deadline window inside attestation.request()
     * @param {number} [opts.gasCeiling]     - Per-call gas ceiling for a cross-contract callee
     *                                         (the caller-funded gasLimit reservation). Clamped to
     *                                         the constructor ceiling; omitted for top-level runs.
     * @param {number} [opts.callDepth]      - Cross-contract call depth (0 = user-submitted EXECUTE)
     * @param {number} [opts.actionIndex]    - The executing EXECUTE's action_index; part of the
     *                                         deterministic attestation request_id preimage
     * @param {number} [opts.rootActionIndex] - The root action's on-chain output index (TX_VOUT),
     *                                         a reorg-stable value pinned at the root action and
     *                                         threaded unchanged through nested executions. Bound
     *                                         into the request_id/call_id preimages as the per-root
     *                                         discriminator so two forest roots under one tx_hash
     *                                         (callPath '' both) cannot collide. NOTE: despite the
     *                                         field name, the value carried is TX_VOUT, not
     *                                         action_index (which is reorg-unstable).
     * @returns {Promise<object>} Execution result
     */
    async execute(opts) {
        // Subprocess mode: hand the (fully serializable) opts to the forked
        // worker. Read-only data MUST be plain snapshots here, not closures.
        if (this._executor) return this._executor.execute(opts);

        // Per-call ceiling: a cross-contract callee runs against its caller-funded
        // reservation. Every consensus-visible gasUsed clamp below derives from
        // gasTracker.ceiling, so the clamp follows this resolution automatically.
        const execCeiling       = effectiveCeiling(opts.gasCeiling, this.gasCeiling);
        const gasTracker        = new GasTracker(this.gasSchedule, execCeiling);
        // H-5 gate: NUL-byte state keys wedge the indexer's block merkle root
        // (see isStateKeyNulRejectActive). Network-aware like the async-surface
        // gate; a missing/garbage timestamp resolves to NaN → pre-activation on
        // mainnet.
        const __skBlockTime     = opts.blockContext && Number(opts.blockContext.timestamp);
        const stateManager      = new StateManager(opts.state || {}, this.limits, {
            rejectNulKeys:  isStateKeyNulRejectActive(opts.network, __skBlockTime),
            // Canonical-string-key gate: post-gate, primitive keys normalize via
            // String(key) and non-primitive keys throw deterministically, so the
            // size/NUL/keyCount guards can no longer be skipped by key type.
            normalizeKeys:  isStateKeyTypeNormalizeActive(opts.network, __skBlockTime)
        });
        // F-PS gate: recursive prototype-key stripping of emitted params (defense in
        // depth; the shallow top-level strip left nested __proto__/constructor own
        // keys in emissions). It can drop keys from a pathological emitted param, so
        // it moves that emission's hash and activates fleet-wide only at/after the
        // same block-time flag-day as F3-binary/globals + F-NR + F-MO.
        const __psBlockTime     = opts.blockContext && Number(opts.blockContext.timestamp);
        const emissionDeepStrip = Number.isFinite(__psBlockTime) &&
            __psBlockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
        const emissionCollector = new EmissionCollector(this.limits.maxEmissions, emissionDeepStrip);
        const execContext       = { reverted: false };
        // Host-observed corroboration signals for classifyError (e9c3a80b):
        // runStartNs is stamped (monotonic process.hrtime.bigint, NOT Date.now)
        // immediately before runSync so a claimed timeout is checked against
        // real elapsed time; a wall-clock/NTP step backward cannot make the
        // delta undercount and skip the gasUsed=ceiling clamp. The isolate
        // handle lets the classifier check the real disposed flag. Filled in
        // below.
        // wallBudgetMs is resolved ONCE per execution and carried on the signals
        // so the isolate timeout and the classifier's elapsed-time corroboration
        // are the same number: a budget resolved twice could differ if opts were
        // mutated mid-execution, and the classifier would then accept (or reject)
        // a timeout the isolate did not actually enforce.
        const hostSignals       = {
            runStartNs: null,
            getIsolate: () => isolate,
            wallBudgetMs: this.wallClockBudgetMs(opts)
        };

        let isolate = null;

        // Enforce max code size before any expensive work
        const __codeStr   = opts.code || '';
        const __codeBytes = Buffer.byteLength(__codeStr, 'utf8');
        if (__codeBytes > this.limits.maxCodeSize) {
            return this.errorResult(gasTracker, emissionCollector,
                'error: code size exceeds limit (' + this.limits.maxCodeSize + ' bytes)');
        }
        // Hash the source ONCE per execution and share the digest with both source-keyed
        // caches (metered code + lint verdict), instead of hashing a 64KB body twice.
        const __codeHash = crypto.createHash('sha256').update(__codeStr).digest('hex');

        const __execLintCoin   = pkg3CoinFromAddress(opts.contractAddress);
        const __execLintHeight = opts.blockContext && Number(opts.blockContext.height);
        const __lintRefusal = checkExecLint(this, opts, gasTracker, emissionCollector,
            __codeStr, __codeBytes, __codeHash, __execLintCoin, __execLintHeight);
        if (__lintRefusal) return __lintRefusal;

        try {
            // Create isolate and context.
            //
            // A failure to SPAWN the isolate is a fault of THIS host (memory
            // pressure, thread-creation failure, a native binding that loaded
            // but cannot create isolates), not a deterministic property of the
            // contract, so it must never reach classifyError and become one of
            // the frozen STATUS_ERROR_PREFIXES the indexer collapses into a
            // committed consensus status: a healthy peer runs the contract
            // normally, so committing here forks. Raising the same
            // HostFaultError the subprocess executor raises for a spawn failure
            // routes it to the indexer's EXECUTOR_UNAVAILABLE halt-and-retry
            // path, which writes no verdict at all.
            let env;
            try {
                env = this.isolateManager.createIsolate();
            } catch (e) {
                throw new HostFaultError('execution isolate unavailable: ' + e.message);
            }
            isolate = env.isolate;
            const context = env.context;

            // Strip non-deterministic globals. The Promise strip is consensus-gated
            // on the async-surface flag-day (network-aware, mirroring the indexer's
            // VM_BANNED_ASYNC activation): below it Promise is left in place so a
            // from-genesis replay reproduces the historical pre-flag-day execution.
            // The block time is the same value the indexer threads as
            // blockContext.timestamp; a missing/garbage timestamp resolves to NaN →
            // pre-activation (Promise left in place) for any non-pre-launch network.
            const __asyncBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
            const stripPromise = isAsyncSurfaceActive(opts.network, __asyncBlockTime);
            // Package 3 VM-sandbox bundle activation, computed ONCE per execution and
            // reused for every leg (WebAssembly strip, Set/Map metering, musl depth
            // bound) so an execution can never partially activate the bundle. Gated
            // per-coin on the ~961000 height flag-day: coin derived from the
            // C:<COIN>:<idx> address so LTC/DOGE mainnet (tips already past a bare BTC
            // 961000) stay pre-activation until their own calendar height; below the
            // gate every leg is byte-identical to today.
            // Coin + height were already derived above for the execute-time lint gate;
            // reuse them so the two per-coin height gates cannot drift apart.
            const __pkg3Coin   = __execLintCoin;
            const __pkg3Height = __execLintHeight;
            const __pkg3SandboxOn = isPkg3SandboxActive(opts.network, __pkg3Coin, __pkg3Height);
            const __stripBigIntSurface = isBigIntSurfaceStripActive(
                opts.network, __pkg3Coin, __pkg3Height);
            sandbox.stripGlobals(isolate, context, {
                stripPromise,
                stripWasm: __pkg3SandboxOn,
                stripBigIntSurface: __stripBigIntSurface,
            });

            // Resolve read-only data into synchronous accessor objects. Accepts
            // either plain serializable snapshots (the canonical form, required by
            // subprocess mode) or legacy closure accessors (in-process back-compat).
            const accessors = resolveAccessors(opts, isAccessorOwnKeyActive(
                opts.network, opts.blockContext && opts.blockContext.timestamp));

            // Build gateway on host side
            const gateway = buildGateway(
                gasTracker, stateManager, emissionCollector,
                buildGatewayOptions(this, opts, accessors),
                this.gasSchedule,
                execContext
            );

            // Inject gateway methods as ivm.Reference objects
            this.injectGateway(context, gateway);

            context.global.setSync('__gas', makeGasReference(gasTracker, opts));

            const __iterSetMeterOn = injectExecutionGlobals(context, opts, __pkg3SandboxOn, this.limits);

            // Run harness script to assemble xchain object inside isolate.
            // Reuse cached V8 bytecode when available: the harness source is a
            // fixed constant, so the compiled form is identical for every call.
            const harnessScript = this.isolateManager.compileScript(
                isolate, this._harnessSource, this._harnessCachedData
            );
            if (!this._harnessCachedData) {
                try { this._harnessCachedData = this.isolateManager.getCachedData(harnessScript); } catch (e) { /* non-fatal */ }
            }
            harnessScript.runSync(context);

            // Meter the contract code. L-3 gate: resolve spec-correct `obj[k] += rhs`
            // evaluation order from this execution's block time (isMeteringEvalOrderActive),
            // the same network-aware route the H-5 state-key gate uses. A missing/garbage
            // timestamp resolves to NaN, so an un-timestamped caller stays pre-gate on
            // mainnet (legacy __setconcat order). Below the gate the transform output is
            // byte-identical to the historical form.
            const __moBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
            const __specEvalOrder = isMeteringEvalOrderActive(opts.network, __moBlockTime);
            // Same block-time route resolves the call/new argument-spread metering gate
            // (isCallSpreadMeterActive); below it the spread is emitted verbatim (legacy).
            const __meterCallSpread = isCallSpreadMeterActive(opts.network, __moBlockTime) || __iterSetMeterOn;
            // ...and the destructuring-rest metering gate (isRestPatternMeterActive).
            // Below it a rest destructure is emitted verbatim (legacy flat __gas(1)), so
            // a pre-gate block replays byte-identically; at/after it the rest SOURCE is
            // routed through __arrspread/__objspreadmeter and the O(n) copy is billed.
            const __meterRestPattern = isRestPatternMeterActive(opts.network, __moBlockTime);
            let meteredCode;
            try {
                meteredCode = this.getMeteredCode(
                    __codeStr, __specEvalOrder, __meterCallSpread, __meterRestPattern, __codeHash);
            } catch (e) {
                return this.errorResult(gasTracker, emissionCollector, 'error: metering failed: ' + e.message);
            }

            // Compile the contract wrapper with the metered code injected as a string.
            // Wrap in IIFE so __contractCode/__methodName are local, not global.
            // VM_LINT_HARDENING (gated): pass the control bindings as IIFE
            // PARAMETERS so they never enter the global lexical scope where the
            // Function-constructed contract body could read or shadow them
            // (see CONTRACT_WRAPPER_HARDENED). Pre-gate the legacy script-level
            // `let` form compiles byte-identical to the historical source.
            const __wrapperHardened = isLintHardeningActive(opts.network, __moBlockTime);
            const fullSource = buildContractSource(opts, meteredCode, __wrapperHardened);

            // Per-block compilation cache. The key MUST cover every byte that varies
            // in the compiled source, not just opts.code. fullSource also bakes in
            // __methodName and the __isCrossCall/__readManifest flags (and the metered
            // body, which the L-3 eval-order gate can rewrite), so keying on opts.code
            // alone collided two executes of the same contract at the same index that
            // differ only by method: e.g. "increment"/"decrement" (same length) yield
            // same-length fullSource, and V8 accepted one method's cachedData for the
            // other, running the wrong method's bytecode. This was inert while the
            // cache was dead (M-15); keying on sha256(fullSource) makes every cache
            // hit byte-exact.
            const fullHash = crypto.createHash('sha256').update(fullSource).digest('hex');
            const cacheKey = (opts.contractIndex != null ? opts.contractIndex : '0') + ':' + fullHash;
            let cachedData = null;
            if (this._blockCache && this._blockCache.has(cacheKey))
                cachedData = this._blockCache.get(cacheKey);

            let script;
            try {
                script = this.isolateManager.compileScript(isolate, fullSource, cachedData);
            } catch (e) {
                return this.errorResult(gasTracker, emissionCollector, 'error: compilation failed: ' + e.message);
            }

            // Store in compilation cache
            if (this._blockCache && !this._blockCache.has(cacheKey) &&
                this._blockCache.size < (this.limits.maxBlockCacheSize || 1000)) {
                try {
                    const newCachedData = this.isolateManager.getCachedData(script);
                    this._blockCache.set(cacheKey, newCachedData);
                } catch (e) {
                    // Cache extraction failure is non-fatal
                }
            }

            // Execute. Suppress HOST-side stack capture for the duration of the
            // synchronous contract run. When contract recursion overflows the OS
            // stack, V8 cannot run the isolate's prepareStackTrace hook and falls
            // back to its default formatter; because every metered call crosses
            // into the host via __gas/applySync, the overflow trace is captured
            // host-side and includes HOST frames with real filesystem paths and
            // per-deployment line numbers. A contract can read that through
            // `catch (e) { return e.stack }`, leaking host paths into hashed state
            // (info-leak + per-validator nondeterminism -> fork). Forcing the host
            // limit to 0 + a constant prepareStackTrace makes any host-captured
            // trace empty, leaving only deterministic isolate frames. Restored in
            // finally; execute() runs contracts strictly sequentially, so this
            // window overlaps no other host work. (The in-isolate stackTraceLimit
            // set by sandbox.js covers the normal, non-overflow path.)
            let returnValue = null;
            const __hostStackLimit = Error.stackTraceLimit;
            const __hostPrepare = Error.prepareStackTrace;
            Error.stackTraceLimit = 0;
            Error.prepareStackTrace = function() { return ''; };
            try {
                hostSignals.runStartNs = process.hrtime.bigint();
                // CONSENSUS: the timeout is the per-execution wall-clock budget
                // resolved above, NOT the node's limits.maxCpuTimeMs (which binds
                // ungated executions only). See consensus-wall-clock.js.
                const rawReturn = script.runSync(context, { timeout: hostSignals.wallBudgetMs });
                returnValue = extractReturnValue(rawReturn);
            } catch (execError) {
                // Classify the error
                return this.classifyError(execError, gasTracker, emissionCollector, opts, execContext, hostSignals);
            } finally {
                // Restore host stack-capture settings (see note above).
                Error.stackTraceLimit = __hostStackLimit;
                Error.prepareStackTrace = __hostPrepare;
            }

            // Activation for failing a run whose gas-exhaustion fault was caught inside the
            // isolate (the Object.* statics wrappers swallow it) and so reached the host as a
            // success. Post-gate such a run is out_of_gas at the ceiling; pre-gate it replays as
            // the success it settled as. Resolver and map live in gas.js beside the tracker flag.
            if (gasTracker.exhausted && GasTracker.isGasCeilingSuccessActive(opts.network, __moBlockTime)) {
                return this.errorResult(gasTracker, emissionCollector,
                    'out_of_gas: used ' + gasTracker.used + ' of ' + gasTracker.ceiling, gasTracker.ceiling);
            }

            // Collect results
            const { changes, deletes } = stateManager.getChanges();
            const emittedActions = emissionCollector.getActions();

            // Validate emissions
            for (const action of emittedActions) {
                try {
                    this.actionValidator.validate(action);
                } catch (e) {
                    return this.errorResult(gasTracker, emissionCollector, 'error: invalid emission: ' + e.message);
                }
            }

            return {
                success:        true,
                error:          null,
                gasUsed:        gasTracker.getUsed(),
                returnValue:    returnValue,
                stateChanges:   changes,
                stateDeletes:   deletes,
                emittedActions: emittedActions,
                logs:           emissionCollector.getLogs()
            };

        } catch (outerError) {
            // Catch-all for unexpected errors
            return this.classifyError(outerError, gasTracker, emissionCollector, opts, execContext, hostSignals);
        } finally {
            if (isolate) this.isolateManager.dispose(isolate);
        }
    },
};
