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
    // Helper: wrap a host reference into a callable function.
    // Arguments are JSON-serialized before crossing the isolate boundary;
    // return values are JSON-deserialized after crossing back.
    // This is required because isolated-vm only transfers primitives via applySync.
    function wrap(ref) {
        return function() {
            var jsonArgs = JSON.stringify(Array.prototype.slice.call(arguments));
            var jsonResult = ref.applySync(undefined, [jsonArgs]);
            if (jsonResult === undefined || jsonResult === null) return jsonResult;
            if (typeof jsonResult === 'string' && jsonResult.charAt(0) === '\x01') {
                return JSON.parse(jsonResult.substring(1));
            }
            return jsonResult;
        };
    }

    // Wrap __gas Reference into a callable function for metered code.
    // Use __defineProperty (saved by sandbox before stripping Object.defineProperty)
    // to make __gas non-writable/non-configurable so contracts cannot overwrite it.
    var __gasRef = globalThis.__gas;
    var __gasFunc = function() { __gasRef.applySync(undefined, []); };
    var __defProp = globalThis.__defineProperty;
    delete globalThis.__gas;
    __defProp(globalThis, '__gas', {
        value: __gasFunc,
        writable: false,
        configurable: false,
        enumerable: false
    });
    // Clean up __defineProperty — no longer needed
    delete globalThis.__defineProperty;

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

        // External attestation framework (metered)
        attestation: Object.freeze({
            request:      wrap(globalThis.__attestation_request),
            getResponse:  wrap(globalThis.__attestation_getResponse)
        }),

        // Contract-targeted staking (metered)
        // Scoped to the currently-executing contract — read-only access to its own
        // stake table + a slash() primitive routing to the contract's locked destination.
        contract: Object.freeze({
            getStake:       wrap(globalThis.__contract_getStake),
            getTotalStaked: wrap(globalThis.__contract_getTotalStaked),
            getStakers:     wrap(globalThis.__contract_getStakers),
            slash:          wrap(globalThis.__contract_slash)
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

        // Math (wrapped from individual host-side References)
        math: Object.freeze({
            add:      wrap(globalThis.__math_add),
            subtract: wrap(globalThis.__math_subtract),
            multiply: wrap(globalThis.__math_multiply),
            divide:   wrap(globalThis.__math_divide),
            mod:      wrap(globalThis.__math_mod),
            compare:  wrap(globalThis.__math_compare),
            gt:       wrap(globalThis.__math_gt),
            gte:      wrap(globalThis.__math_gte),
            lt:       wrap(globalThis.__math_lt),
            lte:      wrap(globalThis.__math_lte),
            eq:       wrap(globalThis.__math_eq),
            min:      wrap(globalThis.__math_min),
            max:      wrap(globalThis.__math_max),
            abs:      wrap(globalThis.__math_abs),
            isZero:   wrap(globalThis.__math_isZero)
        }),

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
        if (names[i].indexOf('__') === 0 && names[i] !== '__gas' && names[i] !== '__Function') {
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
    // Use __Function (saved by sandbox before stripping Function from global scope)
    var module = { exports: {} };
    var exports = module.exports;
    var __Fn = globalThis.__Function;
    delete globalThis.__Function;
    (new __Fn('module', 'exports', 'xchain', __contractCode))(module, exports, xchain);
    var contractExports = module.exports;

    // Invoke the method
    var __result;
    if (typeof contractExports === 'function') {
        __result = contractExports(xchain);
    } else if (typeof contractExports === 'object' && contractExports !== null) {
        var method = contractExports[__methodName];
        if (typeof method !== 'function')
            throw new Error('unknown method: ' + __methodName);
        __result = method(xchain);
    } else {
        throw new Error('contract must export a function or object');
    }
    // JSON-serialize the return value inside the isolate so it can
    // cross the boundary as a string (ivm only transfers primitives)
    if (__result === undefined) return undefined;
    return '\\x02' + JSON.stringify(__result);
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
            maxCodeSize:       65536,
            maxBlockCacheSize: 1000
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
        const execContext       = { reverted: false };

        let isolate = null;

        // Enforce max code size before any expensive work
        if (Buffer.byteLength(opts.code || '', 'utf8') > this.limits.maxCodeSize) {
            return this._errorResult(gasTracker, emissionCollector,
                'error: code size exceeds limit (' + this.limits.maxCodeSize + ' bytes)');
        }

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
                    contractIndex:   opts.contractIndex || null,
                    txHash:          opts.txHash || '',
                    params:          opts.params || [],
                    blockContext:    opts.blockContext,
                    balances:        opts.balances || {},
                    tokenInfo:       opts.tokenInfo || {},
                    oracleData:        opts.oracleData || null,
                    crossChainData:    opts.crossChainData || null,
                    attestationData:   opts.attestationData || null,
                    contractStakeData: opts.contractStakeData || null
                },
                this.gasSchedule,
                execContext
            );

            // Inject gateway methods as ivm.Reference objects
            this._injectGateway(context, gateway);

            // Inject __gas callback for metering
            const gasRef = new ivm.Reference(function() {
                try {
                    gasTracker.chargeComputation();
                } catch (e) {
                    if (e instanceof GasExhaustedError) {
                        throw new Error('\x03GAS:' + e.used + ':' + e.ceiling);
                    }
                    throw e;
                }
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

            // Compile the contract wrapper with the metered code injected as a string.
            // Wrap in IIFE so __contractCode/__methodName are local, not global.
            const escapedCode = JSON.stringify(meteredCode);
            const escapedMethod = JSON.stringify(opts.method || 'default');
            const fullSource = 'let __contractCode = ' + escapedCode + ';\n' +
                               'let __methodName = ' + escapedMethod + ';\n' +
                               CONTRACT_WRAPPER;

            let script;
            try {
                script = this.isolateManager.compileScript(isolate, fullSource, cachedData);
            } catch (e) {
                return this._errorResult(gasTracker, emissionCollector, 'error: compilation failed: ' + e.message);
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

            // Execute
            let returnValue = null;
            try {
                const rawReturn = script.runSync(context, { timeout: this.limits.maxCpuTimeMs });
                // The contract wrapper JSON-serializes non-null return values
                // with a \x02 prefix inside the isolate
                if (rawReturn !== undefined && rawReturn !== null) {
                    if (typeof rawReturn === 'string' && rawReturn.charCodeAt(0) === 0x02) {
                        const serialized = rawReturn.substring(1);
                        returnValue = serialized.length > 65536 ? serialized.substring(0, 65536) : serialized;
                    } else {
                        try {
                            const serialized = JSON.stringify(rawReturn);
                            if (serialized !== undefined) {
                                returnValue = serialized.length > 65536 ? serialized.substring(0, 65536) : serialized;
                            }
                        } catch (e) {
                            returnValue = null;
                        }
                    }
                }
            } catch (execError) {
                // Classify the error
                return this._classifyError(execError, gasTracker, emissionCollector, opts, execContext);
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
            return this._classifyError(outerError, gasTracker, emissionCollector, opts, execContext);
        } finally {
            if (isolate) this.isolateManager.dispose(isolate);
        }
    }

    /**
     * Inject gateway methods into the isolate context as ivm.Reference objects.
     */
    _injectGateway(context, gateway) {
        const g = context.global;
        // Bridge helper: wraps a host-side function so it can be called from the isolate.
        // Arguments arrive as a single JSON string; ALL non-null/undefined return values
        // are prefixed with \x01 and JSON-encoded so they can cross the boundary safely.
        // This prevents user-supplied strings containing \x01 from being misinterpreted
        // as protocol markers by the harness wrap() function.
        const bridge = (fn) => new ivm.Reference(function(jsonArgs) {
            const args = jsonArgs ? JSON.parse(jsonArgs) : [];
            try {
                const result = fn.apply(undefined, args);
                if (result === null || result === undefined) return result;
                return '\x01' + JSON.stringify(result);
            } catch (e) {
                // Re-throw with a type prefix so the error can be classified
                // after it loses its class crossing the isolate boundary
                if (e instanceof ContractRevertError) {
                    throw new Error('\x03REVERT:' + e.message);
                }
                if (e instanceof GasExhaustedError) {
                    throw new Error('\x03GAS:' + e.used + ':' + e.ceiling);
                }
                throw e;
            }
        });

        // Context accessors (0 gas)
        g.setSync('__getBlockHeight',     bridge(gateway.getBlockHeight));
        g.setSync('__getBlockTimestamp',   bridge(gateway.getBlockTimestamp));
        g.setSync('__getBlockHash',        bridge(gateway.getBlockHash));
        g.setSync('__getSourceAddress',    bridge(gateway.getSourceAddress));
        g.setSync('__getContractAddress',  bridge(gateway.getContractAddress));
        g.setSync('__getInputParams',      bridge(gateway.getInputParams));
        g.setSync('__getInputParam',       bridge(gateway.getInputParam));
        g.setSync('__getInputParamCount',  bridge(gateway.getInputParamCount));

        // Ledger queries (metered)
        g.setSync('__getBalance',   bridge(gateway.getBalance));
        g.setSync('__getTokenInfo', bridge(gateway.getTokenInfo));

        // State (metered)
        g.setSync('__state_get',    bridge(gateway.state.get));
        g.setSync('__state_has',    bridge(gateway.state.has));
        g.setSync('__state_set',    bridge(gateway.state.set));
        g.setSync('__state_delete', bridge(gateway.state.delete));

        // Oracle (metered)
        g.setSync('__oracle_getPrice',        bridge(gateway.oracle.getPrice));
        g.setSync('__oracle_getPriceAtRound',  bridge(gateway.oracle.getPriceAtRound));
        g.setSync('__oracle_getSnapshotAge',   bridge(gateway.oracle.getSnapshotAge));

        // Cross-chain (metered)
        g.setSync('__crossChain_getAttestation', bridge(gateway.crossChain.getAttestation));
        g.setSync('__crossChain_isSettled',      bridge(gateway.crossChain.isSettled));

        g.setSync('__attestation_request',     bridge(gateway.attestation.request));
        g.setSync('__attestation_getResponse', bridge(gateway.attestation.getResponse));

        // Contract-targeted staking (metered)
        g.setSync('__contract_getStake',       bridge(gateway.contract.getStake));
        g.setSync('__contract_getTotalStaked', bridge(gateway.contract.getTotalStaked));
        g.setSync('__contract_getStakers',     bridge(gateway.contract.getStakers));
        g.setSync('__contract_slash',          bridge(gateway.contract.slash));

        // Emit (metered)
        g.setSync('__emit_send',      bridge(gateway.emit.send));
        g.setSync('__emit_destroy',   bridge(gateway.emit.destroy));
        g.setSync('__emit_issue',     bridge(gateway.emit.issue));
        g.setSync('__emit_mint',      bridge(gateway.emit.mint));
        g.setSync('__emit_order',     bridge(gateway.emit.order));
        g.setSync('__emit_dispenser', bridge(gateway.emit.dispenser));
        g.setSync('__emit_dividend',  bridge(gateway.emit.dividend));
        g.setSync('__emit_airdrop',   bridge(gateway.emit.airdrop));
        g.setSync('__emit_callback',  bridge(gateway.emit.callback));
        g.setSync('__emit_file',      bridge(gateway.emit.file));
        g.setSync('__emit_list',      bridge(gateway.emit.list));
        g.setSync('__emit_coinpay',   bridge(gateway.emit.coinpay));
        g.setSync('__emit_sweep',     bridge(gateway.emit.sweep));
        g.setSync('__emit_link',      bridge(gateway.emit.link));
        g.setSync('__emit_broadcast', bridge(gateway.emit.broadcast));
        g.setSync('__emit_message',   bridge(gateway.emit.message));

        // Math
        g.setSync('__math_add',      bridge(gateway.math.add));
        g.setSync('__math_subtract', bridge(gateway.math.subtract));
        g.setSync('__math_multiply', bridge(gateway.math.multiply));
        g.setSync('__math_divide',   bridge(gateway.math.divide));
        g.setSync('__math_mod',      bridge(gateway.math.mod));
        g.setSync('__math_compare',  bridge(gateway.math.compare));
        g.setSync('__math_gt',       bridge(gateway.math.gt));
        g.setSync('__math_gte',      bridge(gateway.math.gte));
        g.setSync('__math_lt',       bridge(gateway.math.lt));
        g.setSync('__math_lte',      bridge(gateway.math.lte));
        g.setSync('__math_eq',       bridge(gateway.math.eq));
        g.setSync('__math_min',      bridge(gateway.math.min));
        g.setSync('__math_max',      bridge(gateway.math.max));
        g.setSync('__math_abs',      bridge(gateway.math.abs));
        g.setSync('__math_isZero',   bridge(gateway.math.isZero));

        // Control flow (gas-free)
        g.setSync('__revert',  bridge(gateway.revert));
        g.setSync('__require', bridge(gateway.require));

        // Logging (gas-free)
        g.setSync('__log',         bridge(gateway.log));
        g.setSync('__isLogFull',   bridge(gateway.isLogFull));
        g.setSync('__getLogCount', bridge(gateway.getLogCount));
    }

    /**
     * Classify an execution error and return the appropriate result.
     */
    _classifyError(error, gasTracker, emissionCollector, opts, execContext) {
        if (error instanceof ContractRevertError) {
            return this._errorResult(gasTracker, emissionCollector, 'revert: ' + error.message);
        }
        if (error instanceof GasExhaustedError) {
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_gas: used ' + error.used + ' of ' + error.ceiling);
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
                return this._errorResult(gasTracker, emissionCollector, 'revert: ' + reason);
            }
            if (payload.startsWith('GAS:') && gasTracker.used > gasTracker.ceiling) {
                return this._errorResult(gasTracker, emissionCollector,
                    'out_of_gas: used ' + gasTracker.used + ' of ' + gasTracker.ceiling);
            }
        }
        // isolated-vm timeout errors
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
        // Generic contract error — sanitize to prevent information leakage (RISK-15).
        // Strip stack traces, file paths, and internal details.
        return this._errorResult(gasTracker, emissionCollector, 'error: ' + this._sanitizeError(msg));
    }

    /**
     * Sanitize an error message to prevent information leakage.
     * Returns only the first line, strips file paths and stack traces.
     */
    _sanitizeError(msg) {
        if (!msg) return 'unknown error';
        // Take only the first line
        const firstLine = msg.split('\n')[0];
        // Strip file paths (e.g., /home/user/.../file.js:123:45)
        const sanitized = firstLine.replace(/\s*(\/[\w./-]+(?::\d+(?::\d+)?)?)/g, '');
        // Truncate to 256 chars
        return sanitized.length > 256 ? sanitized.substring(0, 256) : sanitized;
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
