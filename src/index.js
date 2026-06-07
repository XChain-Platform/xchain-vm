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
// @ts-nocheck

// 


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
const { resolveAccessors } = require('./readonly-accessors.js');

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
    // Forward the charge amount: 1 for the AST meter's __gas(1) (control flow),
    // or the allocation size for the bulk-allocation wrappers below.
    var __gasFunc = function(n) { __gasRef.applySync(undefined, [(typeof n === 'number' && n > 1) ? n : 1]); };
    var __defProp = globalThis.__defineProperty;
    delete globalThis.__gas;
    __defProp(globalThis, '__gas', {
        value: __gasFunc,
        writable: false,
        configurable: false,
        enumerable: false
    });

    // ----- Allocation-size gas metering (F3) -----
    // Charge gas proportional to the number of elements/chars a bulk-allocation
    // builtin will materialize, BEFORE delegating to the native — so a hostile
    // allocation (new Array(1e8).fill('x'), 'x'.repeat(1e9), Array.from({length:1e8}))
    // trips the deterministic gas ceiling instead of reaching V8's allocator (which
    // would burn ~28s to the wall-clock timeout, or abort the worker). Installed at
    // the PROTOTYPE level so it is aliasing-proof: var f=[].fill; f.call(arr,x) gets
    // the metered wrapper, and the native (captured in a closure) is unreachable.
    // Defense-in-depth — the out-of-process executor remains the load-bearing
    // containment for paths that cannot be wrapped (spread, infinite-generator).
    var __lockMethod = function(obj, name, fn) {
        try { __defProp(obj, name, { value: fn, writable: false, configurable: false, enumerable: false }); } catch(e) {}
    };
    var __allocGas = function(n) { var x = +n; if (x > 1) __gas(x); };

    var __fill = Array.prototype.fill;
    if (typeof __fill === 'function') __lockMethod(Array.prototype, 'fill', function() {
        __allocGas(this == null ? 0 : this.length); return __fill.apply(this, arguments);
    });
    var __from = Array.from;
    if (typeof __from === 'function') __lockMethod(Array, 'from', function(src) {
        if (src && typeof src.length === 'number') __allocGas(src.length);
        return __from.apply(this, arguments);
    });
    var __repeat = String.prototype.repeat;
    if (typeof __repeat === 'function') __lockMethod(String.prototype, 'repeat', function(count) {
        var c = +count; if (c > 0) __allocGas(c * this.length); return __repeat.apply(this, arguments);
    });
    var __padStart = String.prototype.padStart;
    if (typeof __padStart === 'function') __lockMethod(String.prototype, 'padStart', function(len) {
        __allocGas(len); return __padStart.apply(this, arguments);
    });
    var __padEnd = String.prototype.padEnd;
    if (typeof __padEnd === 'function') __lockMethod(String.prototype, 'padEnd', function(len) {
        __allocGas(len); return __padEnd.apply(this, arguments);
    });
    // ----- end F3 -----

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
            isZero:   wrap(globalThis.__math_isZero),
            sqrt:     wrap(globalThis.__math_sqrt),
            pow:      wrap(globalThis.__math_pow),
            log:      wrap(globalThis.__math_log),
            log2:     wrap(globalThis.__math_log2),
            log10:    wrap(globalThis.__math_log10)
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

    // ----- Compute/iteration-size gas metering (G1) -----
    // F3 (above) bounded the ALLOCATION builtins; this bounds the COMPUTE/
    // ITERATION builtins that scan / order / serialize a whole collection in
    // native code for a single call site. Pre-fix, a.indexOf(x) / s.split(',') /
    // JSON.stringify(a) over a large working set cost ~1 gas while doing O(n)
    // native work (~66,000 element-touches per gas measured) — a cheap-gas /
    // expensive-CPU throughput attack: a one-fee tx grinds every validator to
    // the wall-clock backstop. We charge gas proportional to the collection
    // length BEFORE delegating, so the deterministic gas ceiling — not the
    // wall-clock net — is the binding constraint. Installed AFTER the reference
    // cleanup above so harness init (which uses indexOf) is not itself charged.
    //
    // Methods that take a per-element JS CALLBACK (map/filter/reduce/forEach/
    // some/every/find/findIndex/flatMap) are already metered by their callback
    // body and are intentionally NOT wrapped. The + string-concat operator is
    // not a method and cannot be wrapped here; an oversized + build is bounded
    // by the isolate memory ceiling / V8 max-string-length (deterministic
    // out_of_resource post-F1), and its only amplification path — feeding the
    // result to an O(n) consumer — is closed by the wrappers below.
    var __meterLen = function(obj, name) {
        var orig = obj[name];
        if (typeof orig !== 'function') return;
        __lockMethod(obj, name, function() {
            __allocGas(this == null ? 0 : this.length);
            return orig.apply(this, arguments);
        });
    };
    // Array — native scan / order / copy / mutate without a per-element callback.
    // (fill is owned by F3; map/filter/etc. are callback-metered — both excluded.)
    // Includes the O(n) mutators (splice/unshift/shift shift every element) and
    // the ES2023 copying methods (toSorted/toReversed/toSpliced/with allocate a
    // full copy). __meterLen no-ops for any absent on the host V8.
    ['indexOf', 'lastIndexOf', 'includes', 'join', 'reverse', 'sort',
     'flat', 'slice', 'copyWithin', 'splice', 'unshift', 'shift',
     'toSorted', 'toReversed', 'toSpliced', 'with'].forEach(function(m) { __meterLen(Array.prototype, m); });
    // String — native scan / copy (regex literals are banned at deploy time; the
    // locale-sensitive case methods are neutered in sandbox.js). repeat/padStart/
    // padEnd are owned by F3.
    ['indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'slice',
     'substring', 'substr', 'split', 'replace', 'replaceAll', 'trim',
     'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].forEach(function(m) { __meterLen(String.prototype, m); });

    // Variadic concat — charge the receiver length plus each argument's length.
    var __aconcat = Array.prototype.concat;
    if (typeof __aconcat === 'function') __lockMethod(Array.prototype, 'concat', function() {
        var n = (this == null ? 0 : this.length);
        for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            n += (a && typeof a.length === 'number') ? a.length : 1;
        }
        __allocGas(n); return __aconcat.apply(this, arguments);
    });
    var __sconcat = String.prototype.concat;
    if (typeof __sconcat === 'function') __lockMethod(String.prototype, 'concat', function() {
        var n = (this == null ? 0 : this.length);
        for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            n += (typeof a === 'string') ? a.length : 1;
        }
        __allocGas(n); return __sconcat.apply(this, arguments);
    });

    // JSON — parse cost scales with the input string; stringify with the output.
    // parse is charged BEFORE (input length is known); stringify is charged AFTER
    // (the only cheap size signal is the result), which still bounds a loop after
    // one pass and bounds a single pass by the gas already paid to allocate the
    // structure. Charging stringify also covers the host-call arg marshaling and
    // return-value serialization — deterministic, and bounded by the 64 KB state
    // and return-value caps.
    if (typeof JSON !== 'undefined') {
        var __jstr = JSON.stringify;
        if (typeof __jstr === 'function') __lockMethod(JSON, 'stringify', function() {
            var r = __jstr.apply(this, arguments);
            if (typeof r === 'string') __allocGas(r.length);
            return r;
        });
        var __jparse = JSON.parse;
        if (typeof __jparse === 'function') __lockMethod(JSON, 'parse', function(text) {
            if (typeof text === 'string') __allocGas(text.length);
            return __jparse.apply(this, arguments);
        });
    }

    // Object statics that enumerate every own property in native code without a
    // callback. The property count is not cheaply known before enumerating, so
    // (like JSON.stringify) charge AFTER by the result size — which still bounds
    // a reuse loop after one pass and bounds a single pass by the gas already
    // paid to build the object. Uses captured natives so the size probe does not
    // re-enter a wrapper. (Object.create with descriptors is already blocked in
    // sandbox.js; getOwnPropertyDescriptors is the remaining bulk enumerator.)
    var __okeys = Object.keys;
    var __meterObjStatic = function(name, toLen) {
        var orig = Object[name];
        if (typeof orig !== 'function') return;
        __lockMethod(Object, name, function() {
            var r = orig.apply(Object, arguments);
            try { __allocGas(toLen(r)); } catch (e) {}
            return r;
        });
    };
    var __lenArr = function(r) { return (r && typeof r.length === 'number') ? r.length : 0; };
    var __lenObj = function(r) { return (r && typeof r === 'object') ? __okeys(r).length : 0; };
    ['keys', 'values', 'entries', 'getOwnPropertyNames', 'getOwnPropertySymbols']
        .forEach(function(n) { __meterObjStatic(n, __lenArr); });
    ['assign', 'getOwnPropertyDescriptors', 'fromEntries']
        .forEach(function(n) { __meterObjStatic(n, __lenObj); });
    // ----- end G1 -----

    // ----- Syntax-level allocation metering (G4): + / += / template / spread -----
    // These operators/syntax allocate strings/arrays/objects of size proportional
    // to their inputs but are invisible to the AST gas meter and cannot be wrapped
    // at the prototype level. The metering pass (metering.js) rewrites them into
    // calls to the helpers below. Each charges gas for the bytes/elements grown
    // BEYOND the largest operand (so doubling — s = s + s — costs O(n) gas total,
    // while incremental append, already loop-metered, is not over-charged), above
    // a threshold so numeric + and small literals cost nothing. Installed as locked
    // globals (like __gas) AFTER the reference cleanup so transformed contract code
    // can call them but cannot overwrite them and harness init is not charged.
    var __GROW_THRESHOLD = 256;
    var __lockGlobal = function(name, fn) {
        try { __defProp(globalThis, name, { value: fn, writable: false, configurable: false, enumerable: false }); } catch(e) {}
    };
    var __slen = function(v) { return (typeof v === 'string') ? v.length : 0; };

    // String + and += (concat / compound assign)  ->  __concat(a, b)
    __lockGlobal('__concat', function(a, b) {
        var r = a + b;
        if (typeof r === 'string') {
            var la = __slen(a), lb = __slen(b);
            var grew = r.length - (la > lb ? la : lb);
            if (grew > __GROW_THRESHOLD) __gas(grew);
        }
        return r;
    });

    // Template literal  ->  __tmpl([quasi0, expr0, quasi1, ...])
    // Joins with native + (this helper's source is NOT transformed, so no
    // recursion) and coerces each part with '' + p (ToString; throws on Symbol,
    // matching real template semantics).
    __lockGlobal('__tmpl', function(parts) {
        var r = '', maxLen = 0;
        for (var i = 0; i < parts.length; i++) {
            var s = '' + parts[i];
            r = r + s;
            if (s.length > maxLen) maxLen = s.length;
        }
        var grew = r.length - maxLen;
        if (grew > __GROW_THRESHOLD) __gas(grew);
        return r;
    });

    // Array spread  [a, ...x, b]  ->  __arrspread([['e',a], ['s',x], ['e',b]])
    // Unlike string + (V8 cons-strings make raw concat cheap), array spread is a
    // genuine O(n) element COPY, so charge by the TOTAL elements spread (every one
    // is allocated/copied), not "grown beyond largest". Native [...val] does the
    // copy (helper source not transformed); charged after (a single spread is
    // bounded by the gas paid to build its source, a loop trips out_of_gas).
    __lockGlobal('__arrspread', function(segments) {
        var r = [], spread = 0;
        for (var i = 0; i < segments.length; i++) {
            var kind = segments[i][0], val = segments[i][1];
            if (kind === 's') {
                var a = [...val];
                spread += a.length;
                for (var j = 0; j < a.length; j++) r.push(a[j]);
            } else {
                r.push(val);
            }
        }
        if (spread > __GROW_THRESHOLD) __gas(spread);
        return r;
    });

    // Object spread  {...x, k: v}  ->  __objspread([['s',x], ['p',['k',v]]])
    // Parallels the G1 Object.assign wrapper (which does not catch {...x} syntax).
    // Charge by total own-keys copied from spread sources (O(n) copy). Uses the
    // captured native __okeys to avoid re-entering the wrapped Object.keys.
    __lockGlobal('__objspread', function(targets) {
        var r = {}, spread = 0;
        for (var i = 0; i < targets.length; i++) {
            var kind = targets[i][0], val = targets[i][1];
            if (kind === 's') {
                if (val != null) {
                    var ks = __okeys(val);
                    spread += ks.length;
                    for (var j = 0; j < ks.length; j++) r[ks[j]] = val[ks[j]];
                }
            } else {
                r[val[0]] = val[1];
            }
        }
        if (spread > __GROW_THRESHOLD) __gas(spread);
        return r;
    });
    // ----- end G4 -----
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

// Maximum smart-contract code size (64 KiB). Canonical value:
// xchain-documentation/protocol/constants.js (MAX_CODE_SIZE); kept equal to the
// SDK and indexer by the cross-service regression suite (exported at the bottom
// of this module).
const MAX_CODE_SIZE = 65536;

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
            maxCodeSize:       MAX_CODE_SIZE,
            maxBlockCacheSize: 1000
        };
        this.isolateManager = new IsolateManager(this.limits);
        this.actionValidator = new ActionValidator();

        // Per-block compilation cache: Map<contractIndex:codeHash, cachedData>
        this._blockCache = null;

        // Pre-compile the harness script source (it's the same every time)
        this._harnessSource = HARNESS_SOURCE;

        // Execution mode.
        //   'in-process' (default): run the isolate in THIS process. Fast; used
        //       by the whole test/bench suite and by syntax validation.
        //   'subprocess': run every execution in a forked child via ProcessExecutor,
        //       so a contract that aborts V8 (process-wide SIGABRT — e.g. a bulk
        //       allocation that bypasses the isolate memory limit) crashes only the
        //       child, never the host. PRODUCTION (the indexer) MUST use this.
        // Default is in-process so existing in-process callers (which pass closure
        // accessors that can't cross IPC) keep working unchanged; the indexer opts
        // into 'subprocess' explicitly.
        this.execution = config.execution || 'in-process';
        this._executor = null;
        if (this.execution === 'subprocess') {
            // Lazy require to avoid loading child_process for in-process callers.
            const ProcessExecutor = require('./process-executor.js');
            this._executor = new ProcessExecutor(config);
        }
    }

    /**
     * Called at the start of each block to initialize the compilation cache.
     */
    beginBlock() {
        if (this._executor) return this._executor.beginBlock();
        this._blockCache = new Map();
    }

    /**
     * Called at the end of each block to clear the compilation cache.
     */
    endBlock() {
        if (this._executor) return this._executor.endBlock();
        this._blockCache = null;
    }

    /**
     * Tear down the subprocess executor (kills the worker child). No-op in
     * in-process mode. Call from long-lived hosts on shutdown and from tests.
     */
    async shutdown() {
        if (this._executor) return this._executor.shutdown();
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
     * @param {object} [opts.providerDeadlines] - { [providerId]: maxDeadlineBlocks } map; enforces
     *                                            the per-provider deadline window inside attestation.request()
     * @returns {Promise<object>} Execution result
     */
    async execute(opts) {
        // Subprocess mode: hand the (fully serializable) opts to the forked
        // worker. Read-only data MUST be plain snapshots here, not closures.
        if (this._executor) return this._executor.execute(opts);

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

            // Resolve read-only data into synchronous accessor objects. Accepts
            // either plain serializable snapshots (the canonical form, required by
            // subprocess mode) or legacy closure accessors (in-process back-compat).
            const accessors = resolveAccessors(opts);

            // Build gateway on host side
            const gateway = buildGateway(
                gasTracker, stateManager, emissionCollector,
                {
                    caller:          opts.caller,
                    contractAddress: opts.contractAddress,
                    contractIndex:   opts.contractIndex != null ? Number(opts.contractIndex) : null,
                    txHash:          opts.txHash || '',
                    params:          opts.params || [],
                    blockContext:    opts.blockContext,
                    balances:        opts.balances || {},
                    tokenInfo:       opts.tokenInfo || {},
                    oracleData:        accessors.oracleData,
                    crossChainData:    accessors.crossChainData,
                    attestationData:   accessors.attestationData,
                    contractStakeData: accessors.contractStakeData,
                    providerDeadlines: opts.providerDeadlines || null
                },
                this.gasSchedule,
                execContext
            );

            // Inject gateway methods as ivm.Reference objects
            this._injectGateway(context, gateway);

            // Inject __gas callback for metering. `units` is the number of
            // computation steps to charge: the AST meter passes 1 (control flow);
            // the allocation-metering wrappers (harness) pass the requested
            // allocation size, so a bulk allocation trips the gas ceiling BEFORE V8
            // services it. Sanitize to a positive integer (default 1); a huge units
            // deterministically throws GasExhaustedError at the ceiling.
            const gasRef = new ivm.Reference(function(units) {
                try {
                    const n = (typeof units === 'number' && isFinite(units) && units >= 1) ? Math.floor(units) : 1;
                    gasTracker.charge(gasTracker.schedule.VM_COMPUTATION * n);
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
            const cacheKey = (opts.contractIndex != null ? opts.contractIndex : '0') + ':' + codeHash;
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
            } finally {
                // Restore host stack-capture settings (see note above).
                Error.stackTraceLimit = __hostStackLimit;
                Error.prepareStackTrace = __hostPrepare;
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
        g.setSync('__math_sqrt',     bridge(gateway.math.sqrt));
        g.setSync('__math_pow',      bridge(gateway.math.pow));
        g.setSync('__math_log',      bridge(gateway.math.log));
        g.setSync('__math_log2',     bridge(gateway.math.log2));
        g.setSync('__math_log10',    bridge(gateway.math.log10));

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
            // Clamp the consensus-visible gasUsed to the ceiling. A single charge can
            // overshoot the ceiling by a lot (the allocation wrappers charge the full
            // requested size, e.g. 1e8 for Array(1e8).fill), but a contract allotted
            // `ceiling` gas must never be billed beyond it — otherwise fee = gasUsed *
            // GAS_PRICE could exceed the caller's committed budget and drive balances
            // negative. The raw `used` stays in the (un-hashed) error message for debugging.
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_gas: used ' + error.used + ' of ' + error.ceiling, this.gasCeiling);
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
                    'out_of_gas: used ' + gasTracker.used + ' of ' + gasTracker.ceiling, this.gasCeiling);
            }
        }
        // ── Non-deterministic resource terminations ──────────────────────────
        // Wall-clock timeout, isolate memory limit, and native stack overflow all
        // fire at machine-/GC-/stack-depth-dependent points, so gasTracker.getUsed()
        // at that instant DIFFERS across validators. Since the indexer computes
        // fee = gasUsed * GAS_PRICE (consensus-critical), a nondeterministic gasUsed
        // would diverge fees → fork. We therefore CLAMP gasUsed to the gas ceiling
        // for every non-gas, non-revert resource termination: the contract provably
        // consumed the maximum allowed resources, and the ceiling is identical on
        // every node. This is the deterministic, fork-safe charge.
        if (msg.includes('Script execution timed out') || msg.includes('disposed')) {
            // Wall-clock timeout — this is a consensus risk. Log at ERROR level.
            console.error('[VM TIMEOUT] Wall-clock safety net triggered. ' +
                (opts ? 'contract=' + opts.contractAddress + ' method=' + opts.method : ''));
            return this._errorResult(gasTracker, emissionCollector,
                'timeout: wall-clock safety net triggered', this.gasCeiling);
        }
        // Memory limit
        if (msg.includes('out of memory') || msg.includes('Array buffer allocation failed')) {
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_memory: isolate memory limit exceeded', this.gasCeiling);
        }
        // Native stack overflow (e.g. deep/infinite recursion). The V8 stack-depth
        // limit varies by architecture and V8 build, so gasUsed here is also
        // platform-dependent → clamp to the ceiling with a deterministic message.
        if (msg.includes('Maximum call stack size exceeded') || msg.includes('call stack')) {
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_stack: maximum call depth exceeded', this.gasCeiling);
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
    _errorResult(gasTracker, emissionCollector, errorMsg, gasOverride) {
        return {
            success:        false,
            error:          errorMsg,
            // gasOverride bounds the consensus-visible gasUsed to the gas ceiling:
            // for non-deterministic resource terminations (timeout / out_of_memory /
            // out_of_stack) so gasUsed — and therefore the fee — is identical on every
            // validator, and for out_of_gas so a single over-ceiling charge (the
            // allocation wrappers) can never bill the caller beyond their committed budget.
            gasUsed:        (gasOverride != null) ? gasOverride : gasTracker.getUsed(),
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
// Expose the canonical code-size cap so the cross-service regression suite can
// assert it has not drifted from the protocol constant.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;
// Expose the pinned consensus runtime + checker so the indexer (and any
// validator process bundling the VM) can gate the engine version it runs on.
const consensusRuntime = require('./consensus-runtime.js');
module.exports.CONSENSUS_RUNTIME = consensusRuntime.PINNED;
module.exports.checkConsensusRuntime = consensusRuntime.checkConsensusRuntime;
module.exports.describeRuntimeMismatch = consensusRuntime.describeMismatch;
// Expose HostFaultError so a host that cannot run contracts (permanently broken
// subprocess executor) is recognisable by callers — they must HALT, not commit
// a fabricated result that would fork the chain.
module.exports.HostFaultError = require('./errors.js').HostFaultError;
