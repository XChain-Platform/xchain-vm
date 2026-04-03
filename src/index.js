/*********************************************************************
 * XChain VM — Main Entry Point
 *
 * The XChainVM class is the public API for the VM runtime.
 * It creates V8 isolates, injects the gateway, meters code,
 * executes contracts, and collects results.
 *
 * Usage:
 *   const vm = new XChainVM({ gasSchedule, gasCeiling, limits });
 *   const result = await vm.execute({ code, state, method, params, ... });
 ********************************************************************/

const crypto = require('crypto');
const ivm    = require('isolated-vm');
const fs     = require('fs');

const IsolateManager    = require('./isolate.js');
const GasTracker        = require('./gas.js');
const StateManager      = require('./state.js');
const EmissionCollector = require('./collector.js');
const ActionValidator   = require('./validator.js');
const { buildGateway }  = require('./gateway.js');
const { stripGlobals }  = require('./sandbox.js');
const { meterCode }     = require('./metering.js');
const { validateSyntax, checkFloatWarnings } = require('./syntax.js');
const { ContractRevertError, GasExhaustedError } = require('./errors.js');

/**
 * Harness script that runs inside the isolate to assemble the xchain
 * object from injected ivm.Reference callbacks. Contract code calls
 * xchain.state.get(key) which calls __state_get.applySync(undefined, [key]).
 */
const HARNESS_SOURCE = `
(function() {
    // Helper: wrap a host reference into a callable function
    function wrap(ref) {
        return function() {
            return ref.applySync(undefined, Array.prototype.slice.call(arguments));
        };
    }

    // Build the xchain object from injected references
    globalThis.xchain = Object.freeze({
        // Context (0 gas)
        getBlockHeight:     wrap(globalThis.__getBlockHeight),
        getBlockTimestamp:   wrap(globalThis.__getBlockTimestamp),
        getBlockHash:        wrap(globalThis.__getBlockHash),
        getSourceAddress:    wrap(globalThis.__getSourceAddress),
        getContractAddress:  wrap(globalThis.__getContractAddress),
        getInputParams:      wrap(globalThis.__getInputParams),
        getInputParam:       wrap(globalThis.__getInputParam),
        getInputParamCount:  wrap(globalThis.__getInputParamCount),

        // Ledger queries (metered)
        getBalance:    wrap(globalThis.__getBalance),
        getTokenInfo:  wrap(globalThis.__getTokenInfo),

        // State (metered)
        state: Object.freeze({
            get:    wrap(globalThis.__state_get),
            has:    wrap(globalThis.__state_has),
            set:    wrap(globalThis.__state_set),
            delete: wrap(globalThis.__state_delete)
        }),

        // Oracle (metered)
        oracle: Object.freeze({
            getPrice:        wrap(globalThis.__oracle_getPrice),
            getPriceAtRound: wrap(globalThis.__oracle_getPriceAtRound),
            getSnapshotAge:  wrap(globalThis.__oracle_getSnapshotAge)
        }),

        // Cross-chain (metered)
        crossChain: Object.freeze({
            getAttestation: wrap(globalThis.__crossChain_getAttestation),
            isSettled:      wrap(globalThis.__crossChain_isSettled)
        }),

        // Emit (metered)
        emit: Object.freeze({
            send:      wrap(globalThis.__emit_send),
            destroy:   wrap(globalThis.__emit_destroy),
            issue:     wrap(globalThis.__emit_issue),
            mint:      wrap(globalThis.__emit_mint),
            order:     wrap(globalThis.__emit_order),
            dispenser: wrap(globalThis.__emit_dispenser),
            dividend:  wrap(globalThis.__emit_dividend),
            airdrop:   wrap(globalThis.__emit_airdrop),
            callback:  wrap(globalThis.__emit_callback),
            file:      wrap(globalThis.__emit_file),
            list:      wrap(globalThis.__emit_list),
            coinpay:   wrap(globalThis.__emit_coinpay),
            sweep:     wrap(globalThis.__emit_sweep),
            link:      wrap(globalThis.__emit_link),
            broadcast: wrap(globalThis.__emit_broadcast),
            message:   wrap(globalThis.__emit_message)
        }),

        // Math (NOT wrapped — these are pure functions injected as copyable values)
        // The math object is injected separately as __math and assigned here
        math: globalThis.__math,

        // Control flow (gas-free)
        revert:  wrap(globalThis.__revert),
        require: wrap(globalThis.__require),

        // Logging (gas-free)
        log:         wrap(globalThis.__log),
        isLogFull:   wrap(globalThis.__isLogFull),
        getLogCount: wrap(globalThis.__getLogCount)
    });

    // Clean up injected references from global scope
    var names = Object.getOwnPropertyNames(globalThis);
    for (var i = 0; i < names.length; i++) {
        if (names[i].indexOf('__') === 0 && names[i] !== '__gas') {
            try { delete globalThis[names[i]]; } catch(e) {}
        }
    }
})();
`;

/**
 * Contract wrapper script. Runs the contract code and invokes the
 * specified method (or the default export if it's a function).
 * Injected variables: __contractCode (string), __methodName (string)
 */
const CONTRACT_WRAPPER = `
(function() {
    // Execute the contract code to get the exports
    var module = { exports: {} };
    var exports = module.exports;
    (new Function('module', 'exports', 'xchain', __contractCode))(module, exports, xchain);
    var contractExports = module.exports;

    // Invoke the method
    if (typeof contractExports === 'function') {
        return contractExports(xchain);
    } else if (typeof contractExports === 'object' && contractExports !== null) {
        var method = contractExports[__methodName];
        if (typeof method !== 'function')
            throw new Error('unknown method: ' + __methodName);
        return method(xchain);
    } else {
        throw new Error('contract must export a function or object');
    }
})();
`;

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
        this.limits      = config.limits || {
            maxCpuTimeMs:      30000,
            maxMemory:         8,
            maxEmissions:      50,
            maxStateKeys:      10000,
            maxStateValueSize: 65536,
            maxCodeSize:       65536
        };
        this.isolateManager = new IsolateManager(this.limits);
        this.actionValidator = new ActionValidator();

        // Per-block compilation cache: Map<contractIndex:codeHash, cachedData>
        this._blockCache = null;

        // Pre-compile the harness script source (it's the same every time)
        this._harnessSource = HARNESS_SOURCE;
    }

    /**
     * Called at the start of each block to initialize the compilation cache.
     */
    beginBlock() {
        this._blockCache = new Map();
    }

    /**
     * Called at the end of each block to clear the compilation cache.
     */
    endBlock() {
        this._blockCache = null;
    }

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
     * @returns {Promise<object>} Execution result
     */
    async execute(opts) {
        const gasTracker        = new GasTracker(this.gasSchedule, this.gasCeiling);
        const stateManager      = new StateManager(opts.state || {}, this.limits);
        const emissionCollector = new EmissionCollector(this.limits.maxEmissions);

        let isolate = null;

        try {
            // Create isolate and context
            const env = this.isolateManager.createIsolate();
            isolate = env.isolate;
            const context = env.context;

            // Strip non-deterministic globals
            stripGlobals(isolate, context);

            // Build gateway on host side
            const gateway = buildGateway(
                gasTracker, stateManager, emissionCollector,
                {
                    caller:          opts.caller,
                    contractAddress: opts.contractAddress,
                    params:          opts.params || [],
                    blockContext:    opts.blockContext,
                    balances:        opts.balances || {},
                    tokenInfo:       opts.tokenInfo || {},
                    oracleData:      opts.oracleData || null,
                    crossChainData:  opts.crossChainData || null
                },
                this.gasSchedule
            );

            // Inject gateway methods as ivm.Reference objects
            this._injectGateway(context, gateway);

            // Inject __gas callback for metering
            const gasRef = new ivm.Reference(function() {
                gasTracker.chargeComputation();
            });
            context.global.setSync('__gas', gasRef);

            // Run harness script to assemble xchain object inside isolate
            const harnessScript = isolate.compileScriptSync(this._harnessSource);
            harnessScript.runSync(context);

            // Meter the contract code
            let meteredCode;
            try {
                meteredCode = meterCode(opts.code);
            } catch (e) {
                return this._errorResult(gasTracker, emissionCollector, 'error: metering failed: ' + e.message);
            }

            // Check compilation cache
            const codeHash = crypto.createHash('sha256').update(opts.code).digest('hex');
            const cacheKey = (opts.contractIndex || '0') + ':' + codeHash;
            let cachedData = null;
            if (this._blockCache && this._blockCache.has(cacheKey))
                cachedData = this._blockCache.get(cacheKey);

            // Compile the contract wrapper with the metered code injected as a string
            const escapedCode = JSON.stringify(meteredCode);
            const escapedMethod = JSON.stringify(opts.method || 'default');
            const fullSource = 'var __contractCode = ' + escapedCode + ';\n' +
                               'var __methodName = ' + escapedMethod + ';\n' +
                               CONTRACT_WRAPPER;

            let script;
            try {
                script = this.isolateManager.compileScript(isolate, fullSource, cachedData);
            } catch (e) {
                return this._errorResult(gasTracker, emissionCollector, 'error: compilation failed: ' + e.message);
            }

            // Store in compilation cache
            if (this._blockCache && !this._blockCache.has(cacheKey)) {
                try {
                    const newCachedData = this.isolateManager.getCachedData(script);
                    this._blockCache.set(cacheKey, newCachedData);
                } catch (e) {
                    // Cache extraction failure is non-fatal
                }
            }

            // Execute
            let returnValue = null;
            try {
                const rawReturn = script.runSync(context, { timeout: this.limits.maxCpuTimeMs });
                // Serialize return value
                if (rawReturn !== undefined && rawReturn !== null) {
                    try {
                        const serialized = JSON.stringify(rawReturn);
                        if (serialized !== undefined) {
                            // Truncate to 64KB
                            returnValue = serialized.length > 65536 ? serialized.substring(0, 65536) : serialized;
                        }
                    } catch (e) {
                        returnValue = null;
                    }
                }
            } catch (execError) {
                // Classify the error
                return this._classifyError(execError, gasTracker, emissionCollector, opts);
            }

            // Collect results
            const { changes, deletes } = stateManager.getChanges();
            const emittedActions = emissionCollector.getActions();

            // Validate emissions
            for (const action of emittedActions) {
                try {
                    this.actionValidator.validate(action);
                } catch (e) {
                    return this._errorResult(gasTracker, emissionCollector, 'error: invalid emission: ' + e.message);
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
            return this._classifyError(outerError, gasTracker, emissionCollector, opts);
        } finally {
            if (isolate) this.isolateManager.dispose(isolate);
        }
    }

    /**
     * Inject gateway methods into the isolate context as ivm.Reference objects.
     */
    _injectGateway(context, gateway) {
        const g = context.global;
        const ref = (fn) => new ivm.Reference(fn);

        // Context accessors (0 gas)
        g.setSync('__getBlockHeight',     ref(gateway.getBlockHeight));
        g.setSync('__getBlockTimestamp',   ref(gateway.getBlockTimestamp));
        g.setSync('__getBlockHash',        ref(gateway.getBlockHash));
        g.setSync('__getSourceAddress',    ref(gateway.getSourceAddress));
        g.setSync('__getContractAddress',  ref(gateway.getContractAddress));
        g.setSync('__getInputParams',      ref(gateway.getInputParams));
        g.setSync('__getInputParam',       ref(gateway.getInputParam));
        g.setSync('__getInputParamCount',  ref(gateway.getInputParamCount));

        // Ledger queries (metered)
        g.setSync('__getBalance',   ref(gateway.getBalance));
        g.setSync('__getTokenInfo', ref(gateway.getTokenInfo));

        // State (metered)
        g.setSync('__state_get',    ref(gateway.state.get));
        g.setSync('__state_has',    ref(gateway.state.has));
        g.setSync('__state_set',    ref(gateway.state.set));
        g.setSync('__state_delete', ref(gateway.state.delete));

        // Oracle (metered)
        g.setSync('__oracle_getPrice',        ref(gateway.oracle.getPrice));
        g.setSync('__oracle_getPriceAtRound',  ref(gateway.oracle.getPriceAtRound));
        g.setSync('__oracle_getSnapshotAge',   ref(gateway.oracle.getSnapshotAge));

        // Cross-chain (metered)
        g.setSync('__crossChain_getAttestation', ref(gateway.crossChain.getAttestation));
        g.setSync('__crossChain_isSettled',      ref(gateway.crossChain.isSettled));

        // Emit (metered)
        g.setSync('__emit_send',      ref(gateway.emit.send));
        g.setSync('__emit_destroy',   ref(gateway.emit.destroy));
        g.setSync('__emit_issue',     ref(gateway.emit.issue));
        g.setSync('__emit_mint',      ref(gateway.emit.mint));
        g.setSync('__emit_order',     ref(gateway.emit.order));
        g.setSync('__emit_dispenser', ref(gateway.emit.dispenser));
        g.setSync('__emit_dividend',  ref(gateway.emit.dividend));
        g.setSync('__emit_airdrop',   ref(gateway.emit.airdrop));
        g.setSync('__emit_callback',  ref(gateway.emit.callback));
        g.setSync('__emit_file',      ref(gateway.emit.file));
        g.setSync('__emit_list',      ref(gateway.emit.list));
        g.setSync('__emit_coinpay',   ref(gateway.emit.coinpay));
        g.setSync('__emit_sweep',     ref(gateway.emit.sweep));
        g.setSync('__emit_link',      ref(gateway.emit.link));
        g.setSync('__emit_broadcast', ref(gateway.emit.broadcast));
        g.setSync('__emit_message',   ref(gateway.emit.message));

        // Math — inject as a transferable object (not References, since math is pure)
        // Build math results on the host side and copy them into the isolate
        g.setSync('__math', new ivm.ExternalCopy(gateway.math).copyInto());

        // Control flow (gas-free)
        g.setSync('__revert',  ref(gateway.revert));
        g.setSync('__require', ref(gateway.require));

        // Logging (gas-free)
        g.setSync('__log',         ref(gateway.log));
        g.setSync('__isLogFull',   ref(gateway.isLogFull));
        g.setSync('__getLogCount', ref(gateway.getLogCount));
    }

    /**
     * Classify an execution error and return the appropriate result.
     */
    _classifyError(error, gasTracker, emissionCollector, opts) {
        if (error instanceof ContractRevertError) {
            return this._errorResult(gasTracker, emissionCollector, 'revert: ' + error.message);
        }
        if (error instanceof GasExhaustedError) {
            return this._errorResult(gasTracker, emissionCollector, 'out_of_gas: used ' + error.used + ' of ' + error.ceiling);
        }
        // isolated-vm timeout errors
        const msg = error.message || '';
        if (msg.includes('Script execution timed out') || msg.includes('disposed')) {
            // Wall-clock timeout — this is a consensus risk. Log at ERROR level.
            console.error('[VM TIMEOUT] Wall-clock safety net triggered. ' +
                (opts ? 'contract=' + opts.contractAddress + ' method=' + opts.method : ''));
            return this._errorResult(gasTracker, emissionCollector, 'timeout: wall-clock safety net triggered');
        }
        // Memory limit
        if (msg.includes('out of memory') || msg.includes('Array buffer allocation failed')) {
            return this._errorResult(gasTracker, emissionCollector, 'out_of_memory: isolate memory limit exceeded');
        }
        // Generic contract error
        return this._errorResult(gasTracker, emissionCollector, 'error: ' + msg);
    }

    /**
     * Build a failure result. State changes and emissions are empty (atomicity).
     * Logs are preserved for debugging.
     */
    _errorResult(gasTracker, emissionCollector, errorMsg) {
        return {
            success:        false,
            error:          errorMsg,
            gasUsed:        gasTracker.getUsed(),
            returnValue:    null,
            stateChanges:   [],
            stateDeletes:   [],
            emittedActions: [],
            logs:           emissionCollector.getLogs()
        };
    }

    /**
     * Validate contract code syntax before deployment.
     * @param {string} code
     * @returns {{ valid: boolean, error?: string }}
     */
    validateSyntax(code) {
        return validateSyntax(code);
    }

    /**
     * Check for floating-point usage warnings.
     * @param {string} code
     * @returns {string[]}
     */
    checkFloatWarnings(code) {
        return checkFloatWarnings(code);
    }
}

module.exports = XChainVM;
