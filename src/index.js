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

const crypto = require('crypto');
const ivm    = require('isolated-vm');
const fs     = require('fs');

const IsolateManager    = require('./isolate.js');
const GasTracker        = require('./gas.js');
const { effectiveCeiling } = require('./gas.js');
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

    // ----- Deterministic call-depth state -----
    // Captured before the global-cleanup pass below strips __-prefixed injected
    // names. __DEPTH_LIMIT is a fixed, platform-independent recursion bound chosen
    // safely below the smallest native V8 stack limit across supported
    // architectures, injected by the host (index.js). The counter + flag live in
    // this closure, unreachable from contract code.
    var __DEPTH_LIMIT  = globalThis.__DEPTH_LIMIT;
    var __stackDepth   = 0;
    var __stackPoison  = false;
    // The deterministic stack fault. Its message embeds "call stack" so the host
    // classifier (index.js _classifyError) maps it to the frozen out_of_stack
    // status, exactly like a real native overflow.
    var __stackError = function() { return new Error('maximum call stack depth exceeded'); };
    // ----- end call-depth state -----

    // Forward the charge amount: 1 for the AST meter's __gas(1) (control flow),
    // or the allocation size for the bulk-allocation wrappers below.
    // Also the choke point that makes the stack fault un-swallowable: once depth is
    // poisoned, every metered point (the meter injects __gas(1) at the top of every
    // catch block) re-throws, so a contract cannot catch the fault and resume to
    // read a platform-dependent depth, mirroring how gas exhaustion cannot be
    // caught and swallowed.
    var __gasFunc = function(n) {
        if (__stackPoison) throw __stackError();
        __gasRef.applySync(undefined, [(typeof n === 'number' && n > 1) ? n : 1]);
    };
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
    // builtin will materialize, BEFORE delegating to the native, so a hostile
    // allocation (new Array(1e8).fill('x'), 'x'.repeat(1e9), Array.from({length:1e8}))
    // trips the deterministic gas ceiling instead of reaching V8's allocator (which
    // would burn ~28s to the wall-clock timeout, or abort the worker). Installed at
    // the PROTOTYPE level so it is aliasing-proof: var f=[].fill; f.call(arr,x) gets
    // the metered wrapper, and the native (captured in a closure) is unreachable.
    // Defense-in-depth: the out-of-process executor remains the load-bearing
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
    // ----- Allocation-size gas metering for binary buffers (F3-binary) -----
    // ArrayBuffer and the TypedArray constructors allocate a dense backing store
    // proportional to the requested byte length the instant they run, but the F3
    // wrappers above cover only the Array/String builtins. Left unmetered,
    // new Uint8Array(1 << 20) in a loop costs ~3 gas/iteration yet marches the
    // isolate toward its memoryLimit, where the backing-store allocation throws a
    // CATCHABLE RangeError (Array buffer allocation failed). A contract can
    // catch that and observe heap occupancy / GC timing (a value that depends on
    // the failure point and, written into hashed state, diverges across validators
    // (even identical builds). Charge the byte length up front (as F3 does for
    // fill) so the deterministic gas ceiling binds before the memory limit is
    // reachable. Proxy/Reflect are stripped by sandbox.js, so the F3 closure idiom
    // is used: each global is replaced with a wrapper capturing the native.
    var __setProto = Object.setPrototypeOf;
    var __meterBinaryCtor = function(nm) {
        var Orig = globalThis[nm];
        if (typeof Orig !== 'function') return;
        var isTyped = (typeof Orig.BYTES_PER_ELEMENT === 'number' && Orig.BYTES_PER_ELEMENT > 0);
        var bpe = isTyped ? Orig.BYTES_PER_ELEMENT : 1;
        var Wrapped = function(a) {
            // A number arg is a fresh allocation of (count * bytesPerElement); an
            // array-like / iterable-with-length copy source is the same size. A view
            // over an existing ArrayBuffer (first arg is the buffer) makes no new
            // backing store, so it is left uncharged.
            if (typeof a === 'number') __allocGas(a * bpe);
            else if (isTyped && a && typeof a.length === 'number') __allocGas(a.length * bpe);
            return new Orig(...arguments);
        };
        // Preserve instanceof and the static surface (BYTES_PER_ELEMENT, from, of,
        // ArrayBuffer.isView, …) by aliasing the prototype and inheriting statics.
        Wrapped.prototype = Orig.prototype;
        try { if (typeof __setProto === 'function') __setProto(Wrapped, Orig); } catch(e) {}
        // Route species / (new X()).constructor back through the metered wrapper
        // so the byte-count charge cannot be sidestepped via the instance. (Unlike
        // Array/String, the TypedArray/ArrayBuffer prototype constructors are not
        // neutered by sandbox.js, so this reassignment is the live reference.)
        __lockMethod(Orig.prototype, 'constructor', Wrapped);
        __lockMethod(globalThis, nm, Wrapped);
    };
    var __binCtors = ['ArrayBuffer', 'Uint8Array', 'Int8Array', 'Uint8ClampedArray',
        'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
        'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
    // CONSENSUS GATE: this byte-length charge changes gasUsed (→ contract_hash →
    // fee debit), so it must activate fleet-wide at a coordinated block-time
    // flag-day, never the instant an individual node upgrades, otherwise a
    // mixed-version fleet forks on the first binary-allocating execution. The
    // host injects __blockTime (this execution's block time) and the flag-day
    // constant before this harness runs. Below the flag day (or when no block
    // time was supplied → __blockTime is 0) the constructors are left unmetered,
    // exactly as pre-activation nodes leave them; at/after it every node charges
    // the byte length identically. (Both injected names are __-prefixed and so
    // are stripped by the cleanup pass below, unreachable from contract code.)
    if (typeof __blockTime === 'number' &&
        typeof __BINARY_ALLOC_GATE_BLOCK_TIME === 'number' &&
        __blockTime >= __BINARY_ALLOC_GATE_BLOCK_TIME) {
        for (var __bi = 0; __bi < __binCtors.length; __bi++) __meterBinaryCtor(__binCtors[__bi]);
    }
    // ----- end F3-binary -----

    // Clean up __defineProperty (no longer needed)
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
        getCallDepth:        wrap(globalThis.__getCallDepth),
        getCrossHops:        wrap(globalThis.__getCrossHops),

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
            isSettled:      wrap(globalThis.__crossChain_isSettled),
            getCallResult:  wrap(globalThis.__crossChain_getCallResult)
        }),

        // External attestation framework (metered)
        attestation: Object.freeze({
            request:      wrap(globalThis.__attestation_request),
            getResponse:  wrap(globalThis.__attestation_getResponse)
        }),

        // Contract-targeted staking (metered)
        // Scoped to the currently-executing contract: read-only access to its own
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
            message:   wrap(globalThis.__emit_message),
            execute:   wrap(globalThis.__emit_execute),
            crossExecute: wrap(globalThis.__emit_crossExecute)
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

    // ----- Deterministic call-depth metering -----
    // The AST meter (metering.js Phase 4) wraps every contract function body as
    //   __depth_enter(); try { <body> } finally { __depth_exit(); }
    // so intra-contract recursion is bounded by a fixed, platform-independent depth
    // rather than by V8's architecture-dependent native stack limit. Without this, a
    // contract that catches the native RangeError observes the raw native depth and
    // can commit it into hashed state, diverging validators on different CPUs (or at
    // different host stack depths) → fork. Defined AFTER the cleanup pass so the hooks
    // survive, and locked (like __gas) so contract code cannot overwrite them. When no
    // positive limit was injected the guard is inert (no false trips) and behaviour
    // falls back to the native overflow path.
    __defProp(globalThis, '__depth_enter', {
        value: function() {
            if (__stackPoison) throw __stackError();
            if (__DEPTH_LIMIT > 0 && __stackDepth >= __DEPTH_LIMIT) {
                __stackPoison = true;
                throw __stackError();
            }
            __stackDepth++;
        },
        writable: false, configurable: false, enumerable: false
    });
    __defProp(globalThis, '__depth_exit', {
        value: function() { if (__stackDepth > 0) __stackDepth--; },
        writable: false, configurable: false, enumerable: false
    });
    // ----- end call-depth metering -----

    // ----- Compute/iteration-size gas metering (G1) -----
    // F3 (above) bounded the ALLOCATION builtins; this bounds the COMPUTE/
    // ITERATION builtins that scan / order / serialize a whole collection in
    // native code for a single call site. Pre-fix, a.indexOf(x) / s.split(',') /
    // JSON.stringify(a) over a large working set cost ~1 gas while doing O(n)
    // native work (~66,000 element-touches per gas measured), a cheap-gas /
    // expensive-CPU throughput attack: a one-fee tx grinds every validator to
    // the wall-clock backstop. We charge gas proportional to the collection
    // length BEFORE delegating, so the deterministic gas ceiling, not the
    // wall-clock net, is the binding constraint. Installed AFTER the reference
    // cleanup above so harness init (which uses indexOf) is not itself charged.
    //
    // Methods that take a per-element JS CALLBACK (map/filter/reduce/forEach/
    // some/every/find/findIndex/flatMap) are already metered by their callback
    // body and are intentionally NOT wrapped. The + string-concat operator is
    // not a method and cannot be wrapped here; an oversized + build is bounded
    // by the isolate memory ceiling / V8 max-string-length (deterministic
    // out_of_resource post-F1), and its only amplification path (feeding the
    // result to an O(n) consumer) is closed by the wrappers below.
    var __meterLen = function(obj, name) {
        var orig = obj[name];
        if (typeof orig !== 'function') return;
        __lockMethod(obj, name, function() {
            __allocGas(this == null ? 0 : this.length);
            return orig.apply(this, arguments);
        });
    };
    // Array: native scan / order / copy / mutate without a per-element callback.
    // (fill is owned by F3; map/filter/etc. are callback-metered, both excluded.)
    // Includes the O(n) mutators (splice/unshift/shift shift every element) and
    // the ES2023 copying methods (toSorted/toReversed/toSpliced/with allocate a
    // full copy). __meterLen no-ops for any absent on the host V8.
    ['indexOf', 'lastIndexOf', 'includes', 'join', 'reverse', 'sort',
     'flat', 'slice', 'copyWithin', 'splice', 'unshift', 'shift',
     'toSorted', 'toReversed', 'toSpliced', 'with'].forEach(function(m) { __meterLen(Array.prototype, m); });
    // String: native scan / copy (regex literals are banned at deploy time; the
    // locale-sensitive case methods are neutered in sandbox.js). repeat/padStart/
    // padEnd are owned by F3.
    ['indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'slice',
     'substring', 'substr', 'split', 'replace', 'replaceAll', 'trim',
     'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].forEach(function(m) { __meterLen(String.prototype, m); });

    // Variadic concat: charge the receiver length plus each argument's length.
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

    // JSON: parse cost scales with the input string; stringify with the output.
    // parse is charged BEFORE (input length is known); stringify is charged AFTER
    // (the only cheap size signal is the result), which still bounds a loop after
    // one pass and bounds a single pass by the gas already paid to allocate the
    // structure. Charging stringify also covers the host-call arg marshaling and
    // return-value serialization, deterministic, and bounded by the 64 KB state
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
    // (like JSON.stringify) charge AFTER by the result size, which still bounds
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
    // BEYOND the largest operand (so doubling, s = s + s, costs O(n) gas total,
    // while incremental append, already loop-metered, is not over-charged), above
    // a threshold so numeric + and small literals cost nothing. Installed as locked
    // globals (like __gas) AFTER the reference cleanup so transformed contract code
    // can call them but cannot overwrite them and harness init is not charged.
    var __GROW_THRESHOLD = 256;
    var __lockGlobal = function(name, fn) {
        try { __defProp(globalThis, name, { value: fn, writable: false, configurable: false, enumerable: false }); } catch(e) {}
    };
    var __slen = function(v) { return (typeof v === 'string') ? v.length : 0; };
    var __freeze = Object.freeze;   // unwrapped (only keys/values/assign/... are G1-metered)

    // String + and += on a bare identifier  ->  __concat(a, b)
    __lockGlobal('__concat', function(a, b) {
        var r = a + b;
        if (typeof r === 'string') {
            var la = __slen(a), lb = __slen(b);
            var grew = r.length - (la > lb ? la : lb);
            if (grew > __GROW_THRESHOLD) __gas(grew);
        }
        return r;
    });

    // Compound-assign on a member lhs  obj[k] += b / a.b.c += b  ->  __setconcat(obj, k, b)
    // The metering pass evaluates obj and k once at the call site; this helper does
    // the read/charge/write so a computed/complex lhs (which can't be safely re-read
    // in place) is byte-metered like __concat. Get-once -> charge -> set-once matches
    // native += ordering.
    __lockGlobal('__setconcat', function(obj, key, b) {
        var a = obj[key];
        var r = a + b;
        if (typeof r === 'string') {
            var la = __slen(a), lb = __slen(b);
            var grew = r.length - (la > lb ? la : lb);
            if (grew > __GROW_THRESHOLD) __gas(grew);
        }
        obj[key] = r;
        return r;
    });

    // Tagged template  tag-backtick...  ->  __tmpltag(fn, cooked, raw, [e0,...])      (this=undefined)
    //                  obj.m-backtick...->  __tmpltagm(obj, key, cooked, raw, [...])  (this=obj)
    // Rebuilds the frozen strings template object (cooked array + frozen .raw, as
    // the language produces), charges by string-growth of the parts (string-typed
    // only, never coerces, so we do not fire a toString the tag itself would not),
    // then invokes the tag with the correct receiver. The fn lookup (obj[key]) is
    // resolved here, after the substitutions were evaluated when this call's
    // argument list was built, a benign reorder vs the spec (fn-ref before
    // substitutions) that is identical on every node. The strings object is rebuilt
    // per evaluation rather than cached per call-site; also deterministic.
    var __tagInvoke = function(thisArg, fn, cooked, raw, exprs) {
        __defProp(cooked, 'raw', { value: __freeze(raw), enumerable: false, writable: false, configurable: false });
        __freeze(cooked);
        var total = 0, maxLen = 0, i, L;
        for (i = 0; i < cooked.length; i++) { L = __slen(cooked[i]); total += L; if (L > maxLen) maxLen = L; }
        for (i = 0; i < exprs.length; i++) { L = __slen(exprs[i]); total += L; if (L > maxLen) maxLen = L; }
        var grew = total - maxLen;
        if (grew > __GROW_THRESHOLD) __gas(grew);
        var args = [cooked];
        for (i = 0; i < exprs.length; i++) args.push(exprs[i]);
        return fn.apply(thisArg, args);
    };
    __lockGlobal('__tmpltag', function(fn, cooked, raw, exprs) {
        return __tagInvoke(undefined, fn, cooked, raw, exprs);
    });
    __lockGlobal('__tmpltagm', function(obj, key, cooked, raw, exprs) {
        return __tagInvoke(obj, obj[key], cooked, raw, exprs);
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
 * Injected variables: __contractCode (string), __methodName (string),
 * __isCrossCall (bool), __readManifest (bool, Phase E manifest introspection)
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

    // Permissions-manifest introspection (Phase E). When the host reads a
    // contract's declared policy at deploy time it sets __readManifest, and we
    // surface the exported permissions + maxTakeBps WITHOUT dispatching a method.
    // Type tags are surfaced (not just values) so the indexer can fail-closed on a
    // malformed manifest (e.g. permissions exported as a string, or a non-integer
    // maxTakeBps) rather than silently treating it as absent. All validation +
    // rejection lives host-side (actions/deploy.js); the VM only reports faithfully.
    if (__readManifest) {
        var __ce = (typeof contractExports === 'object' && contractExports !== null) ? contractExports : {};
        return '\\x02' + JSON.stringify({
            permissions:     Array.isArray(__ce.permissions) ? __ce.permissions : null,
            permissionsType: (__ce.permissions === undefined) ? 'undefined' : (Array.isArray(__ce.permissions) ? 'array' : typeof __ce.permissions),
            maxTakeBps:      (typeof __ce.maxTakeBps === 'number') ? __ce.maxTakeBps : null,
            maxTakeBpsType:  (__ce.maxTakeBps === undefined) ? 'undefined' : typeof __ce.maxTakeBps
        });
    }

    // Cross-chain call gate: an injected cross-chain execution may only invoke
    // methods the contract explicitly opted in via an exported crossCallable
    // array. This is the blast-radius bound on the federation's relay authority
    // a quorum-signed dispatch can only reach methods the target contract
    // consciously exposed. The fixed marker string is matched by the indexer
    // (xexec.js) to report status 'not_callable' back to the caller.
    if (__isCrossCall) {
        var __cc = (typeof contractExports === 'object' && contractExports !== null)
            ? contractExports.crossCallable : null;
        if (!Array.isArray(__cc) || __cc.indexOf(__methodName) === -1)
            throw new Error('XCALL_NOT_CALLABLE: method "' + __methodName + '" is not in the crossCallable allowlist');
    }

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

// Cross-contract call protocol constants. Canonical values:
// xchain-documentation/protocol/constants.js (VM_MAX_CALL_DEPTH /
// VM_MIN_CALL_GAS); the indexer re-validates both host-side
// (xchain-indexer/src/actions/execute.js) so an older bundled VM cannot
// bypass them. Exported below for the cross-service regression suite.
const MAX_CALL_DEPTH = 4;
const MIN_CALL_GAS   = 5000;

// Deterministic intra-contract recursion bound. DISTINCT from MAX_CALL_DEPTH
// (which bounds cross-contract emit.execute chains): this caps how deep a single
// contract may recurse WITHIN one isolate before the metering-injected depth guard
// throws a deterministic out_of_stack fault. The value is a fixed, conservative
// constant chosen well below the smallest native V8 stack limit across every
// supported architecture (linux/arm64 + linux/amd64) and across the host stack
// remaining at runSync entry, so the guard always fires before V8's own
// architecture-dependent RangeError. That makes the maximum recursion depth a
// contract can observe identical on every validator. A contract that catches the
// fault can no longer commit a platform-variable depth into hashed state. Purely an
// in-isolate execution bound (the host never re-validates it), so it lives here
// rather than in the cross-service protocol constants; all validators agree on it
// via the pinned consensus runtime version.
const MAX_STACK_DEPTH = 512;

// Cross-CHAIN call (XCALL) protocol constants. Canonical values:
// xchain-documentation/protocol/constants.js; the indexer re-validates
// host-side (execute.js processEmission + actions/xcall.js).
const XCALL_MIN_GAS             = 5000;     // = MIN_CALL_GAS
const XCALL_MAX_GAS             = 200000;   // target-side ceiling cap (the run is fee-less on the target chain)
const XCALL_MAX_HOPS            = 2;        // user→remote = 1, remote→back = 2
const XCALL_MIN_DEADLINE_BLOCKS = 10;
const XCALL_MAX_DEADLINE_BLOCKS = 4000;
const XCALL_MAX_RETURN_BYTES    = 1024;

// Coordinated activation (block time, unix seconds) for binary-allocation gas
// metering (the F3-binary ArrayBuffer/TypedArray byte-length charge in the
// harness below). That charge is a consensus-affecting gas-schedule change: a
// node that applies it and a node that does not produce a different gasUsed for
// the same execution, and gasUsed is hashed into the per-block contract
// checkpoint and drives the fee debit, so applying it to ALL blocks (including
// historical ones) forks any mixed-version fleet on the first binary-allocating
// execution. Gating the metering on a fleet-wide flag-day makes every node flip
// the rule at the same timestamp instead of whenever it happens to upgrade.
// Below the flag day the constructors are UNMETERED (the pre-activation
// behavior); at/after it the byte-length charge applies on every node alike.
// Same coordinated timestamp as the indexer's other 2.0.0 flag-day activations
// (protocol_changes.js). PLACEHOLDER: must be confirmed by the release team
// before mainnet; a value that differs across the fleet is itself a fork.
const BINARY_ALLOC_GATE_BLOCK_TIME = 1798761600;

// Coordinated activation (block time, unix seconds) for the async/Promise
// contract-surface change (CONSENSUS_VERSION '2'): the sandbox strips the global
// `Promise` (sandbox.js) and the deploy validator rejects async/await/Promise
// (lint-core CONSENSUS_RULES 'banned-async'). Both are consensus-affecting: a
// node that strips Promise / rejects an async DEPLOY and a node that does not
// produce a different gasUsed/status (→ contract_hash → fee debit, and a
// different deploy verdict), so a mixed-version fleet forks on the first
// Promise-referencing execution / async DEPLOY. Gating on a fleet-wide flag-day
// makes every node flip together, and a from-genesis replay reproduces the
// historical accept-below/reject-above verdict at every height.
//
// Network-aware, mirroring the indexer's VM_BANNED_ASYNC / DEPLOY_BASE64_CODE
// protocol_changes activations: mainnet defers to the coordinated flag-day;
// testnet/regtest activate at genesis (the pre-launch nets have no pre-activation
// history to preserve and the e2e/regtest stack already ran with the rule live,
// so keeping it on from block 0 preserves their current behaviour). An unknown /
// empty network is treated like mainnet (conservative: requires the flag-day).
// Same coordinated timestamp value as the indexer's other 2.0.0 flag-days and
// BINARY_ALLOC_GATE_BLOCK_TIME (protocol_changes.js: 1798761600). PLACEHOLDER:
// must be confirmed by the release team before mainnet; a value that differs
// across the fleet is itself a fork.
const ASYNC_SURFACE_GATE_BLOCK_TIME = 1798761600;

// Resolve whether the async/Promise surface change is active for a given network
// at a given block time. Used to gate the execution-side Promise strip; the
// deploy-side banned-async rule is gated identically by the indexer via
// protocol_changes.isEnabled('VM_BANNED_ASYNC').
function isAsyncSurfaceActive(network, blockTime) {
    // testnet/regtest: active from genesis (flag day 0).
    if (network === 'testnet' || network === 'regtest') return true;
    // mainnet + unknown/empty: active at/after the coordinated flag-day.
    return Number.isFinite(blockTime) && blockTime >= ASYNC_SURFACE_GATE_BLOCK_TIME;
}

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
        // Cross-contract call limits: default the protocol constants when the
        // caller's limits object predates them (additive, non-breaking).
        if (!Number.isInteger(this.limits.maxCallDepth)) this.limits.maxCallDepth = MAX_CALL_DEPTH;
        if (!Number.isInteger(this.limits.minCallGas))   this.limits.minCallGas   = MIN_CALL_GAS;
        // Intra-contract recursion bound (see MAX_STACK_DEPTH). Default the constant
        // when the caller's limits object predates it (additive, non-breaking).
        if (!Number.isInteger(this.limits.maxStackDepth)) this.limits.maxStackDepth = MAX_STACK_DEPTH;
        this.isolateManager = new IsolateManager(this.limits);
        this.actionValidator = new ActionValidator();

        // Per-block compilation cache: Map<contractIndex:codeHash, cachedData>
        this._blockCache = null;

        // Pre-compile the harness script source (it's the same every time)
        this._harnessSource = HARNESS_SOURCE;
        // Lazily-populated V8 cached data for the harness. The harness source
        // is the same constant string on every execution; per-execution inputs
        // (__blockTime, __BINARY_ALLOC_GATE_BLOCK_TIME) are injected as context
        // globals BEFORE the script runs, not baked into the source, so the
        // compiled bytecode is identical across calls. Storing cachedData here
        // and passing it to compileScriptSync avoids re-parsing the harness on
        // every contract execution, mirroring the per-block contract cache.
        this._harnessCachedData = null;

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
        //
        // The mode string is validated against the two known values: with a bare
        // `config.execution || 'in-process'` fallback, a typo ('subproces',
        // 'sub-process', trailing space) would SILENTLY run in-process and drop
        // host-crash containment (the exact failure the subprocess layer exists
        // to prevent. Unknown values throw at construct time instead.
        if (config.execution !== undefined &&
            config.execution !== 'in-process' && config.execution !== 'subprocess') {
            throw new Error("XChainVM: unknown execution mode '" + config.execution +
                "' use 'subprocess' (production) or 'in-process'");
        }
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

            // Strip non-deterministic globals. The Promise strip is consensus-gated
            // on the async-surface flag-day (network-aware, mirroring the indexer's
            // VM_BANNED_ASYNC activation): below it Promise is left in place so a
            // from-genesis replay reproduces the historical pre-flag-day execution.
            // The block time is the same value the indexer threads as
            // blockContext.timestamp; a missing/garbage timestamp resolves to NaN →
            // pre-activation (Promise left in place) for any non-pre-launch network.
            const __asyncBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
            const stripPromise = isAsyncSurfaceActive(opts.network, __asyncBlockTime);
            stripGlobals(isolate, context, { stripPromise });

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
                    actionIndex:     opts.actionIndex != null ? Number(opts.actionIndex) : null,
                    // Per-root discriminator: the root action's TX_VOUT (reorg-stable on-chain
                    // output index), threaded unchanged through nested executions. Bound into the
                    // request_id/call_id preimages alongside callPath so two VM-executing roots
                    // under one tx_hash (each callPath '') cannot derive the same id. The field
                    // is named rootActionIndex for historical reasons; the value is TX_VOUT, not
                    // action_index. MUST byte-match the indexer's ROOT_ACTION_INDEX field, which
                    // is also populated from TX_VOUT (execute.processEmission).
                    rootActionIndex: opts.rootActionIndex != null ? Number(opts.rootActionIndex) : null,
                    // Deterministic call-path: the '>'-joined per-execution emission
                    // positions from the root on-chain action down to THIS execution
                    // (root = ''). Replaces the injection-timing-dependent action_index
                    // in the attestation request_id + cross-chain call_id preimages so
                    // they stay byte-stable across nodes and reorgs. MUST byte-match the
                    // indexer's EMITTER_PATH (xchain-indexer execute.processEmission).
                    callPath:        typeof opts.callPath === 'string' ? opts.callPath : '',
                    callDepth:       Number.isInteger(opts.callDepth) ? opts.callDepth : 0,
                    maxCallDepth:    this.limits.maxCallDepth,
                    minCallGas:      this.limits.minCallGas,
                    // Cross-chain call context: network + hop budget feed the
                    // emit.crossExecute call_id derivation and hop gate.
                    network:         opts.network || '',
                    crossHops:       Number.isInteger(opts.crossHops) ? opts.crossHops : 0,
                    // Controller-guard mode: when the indexer runs a token's bound
                    // contract `guard` method before a guarded native action settles,
                    // the asynchronous frameworks (attestation, cross-chain calls) are
                    // disabled: their results arrive blocks later, after the guarded
                    // action has already committed or reverted. Enforced at emit time
                    // in gateway.js (attestation.request) + gateway-emit.js (crossExecute).
                    isGuard:         Boolean(opts.isGuard),
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

            // Inject the deterministic recursion bound. The harness captures this
            // into a closure and enforces it on the metering-injected depth hooks,
            // so a contract that catches a stack fault cannot observe a
            // platform-dependent native depth (see MAX_STACK_DEPTH).
            context.global.setSync('__DEPTH_LIMIT', this.limits.maxStackDepth);

            // Inject this execution's block time + the binary-alloc metering
            // flag-day so the harness can gate the F3-binary byte-length charge on
            // the coordinated activation (see BINARY_ALLOC_GATE_BLOCK_TIME). The
            // block time is the same value the indexer threads through as
            // blockContext.timestamp. Coerce to a finite number; a missing/garbage
            // timestamp resolves to 0 → below the flag day → constructors left
            // unmetered (pre-activation behavior), so an un-timestamped caller can
            // never accidentally enable the new charge. Both names are stripped by
            // the harness cleanup pass, so contract code never sees them.
            const __blockTime = opts.blockContext && Number(opts.blockContext.timestamp);
            context.global.setSync('__blockTime', Number.isFinite(__blockTime) ? __blockTime : 0);
            context.global.setSync('__BINARY_ALLOC_GATE_BLOCK_TIME', BINARY_ALLOC_GATE_BLOCK_TIME);

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
                               'let __isCrossCall = ' + JSON.stringify(Boolean(opts.isCrossCall)) + ';\n' +
                               'let __readManifest = ' + JSON.stringify(Boolean(opts.readManifest)) + ';\n' +
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
        g.setSync('__getCallDepth',        bridge(gateway.getCallDepth));
        g.setSync('__getCrossHops',        bridge(gateway.getCrossHops));

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
        g.setSync('__crossChain_getCallResult',  bridge(gateway.crossChain.getCallResult));

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
        g.setSync('__emit_execute',   bridge(gateway.emit.execute));
        g.setSync('__emit_crossExecute', bridge(gateway.emit.crossExecute));

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
     *
     * The error STRING prefixes emitted here (revert/out_of_gas/timeout/
     * out_of_memory/out_of_stack/error; out_of_resource from process-executor)
     * are the frozen STATUS_ERROR_PREFIXES in consensus-runtime.js. The indexer
     * collapses them into CONSENSUS_STATUS_TOKENS (utility.vmFailureStatus).
     * Changing a prefix is a consensus change; guarded by the consensus-params
     * tests in both repos.
     */
    _classifyError(error, gasTracker, emissionCollector, opts, execContext) {
        if (error instanceof ContractRevertError) {
            return this._errorResult(gasTracker, emissionCollector, 'revert: ' + error.message);
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
            return this._errorResult(gasTracker, emissionCollector,
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
                return this._errorResult(gasTracker, emissionCollector, 'revert: ' + reason);
            }
            if (payload.startsWith('GAS:') && gasTracker.used > gasTracker.ceiling) {
                return this._errorResult(gasTracker, emissionCollector,
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
        if (msg.includes('Script execution timed out') || msg.includes('disposed')) {
            // Wall-clock timeout (consensus risk). Log at ERROR level.
            console.error('[VM TIMEOUT] Wall-clock safety net triggered. ' +
                (opts ? 'contract=' + opts.contractAddress + ' method=' + opts.method : ''));
            return this._errorResult(gasTracker, emissionCollector,
                'timeout: wall-clock safety net triggered', gasTracker.ceiling);
        }
        // Memory limit
        if (msg.includes('out of memory') || msg.includes('Array buffer allocation failed')) {
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_memory: isolate memory limit exceeded', gasTracker.ceiling);
        }
        // Native stack overflow (e.g. deep/infinite recursion). The V8 stack-depth
        // limit varies by architecture and V8 build, so gasUsed here is also
        // platform-dependent → clamp to the ceiling with a deterministic message.
        if (msg.includes('Maximum call stack size exceeded') || msg.includes('call stack')) {
            return this._errorResult(gasTracker, emissionCollector,
                'out_of_stack: maximum call depth exceeded', gasTracker.ceiling);
        }
        // Generic contract error: sanitize to prevent information leakage (RISK-15).
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
            // out_of_stack) so gasUsed, and therefore the fee, is identical on every
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
     * @param {object} [opts]
     * @param {boolean} [opts.enforceBannedAsync=true] - block async/await/Promise
     *        (CONSENSUS_RULES 'banned-async'). CONSENSUS-GATED on the indexer:
     *        deploy.js passes the resolved VM_BANNED_ASYNC activation so a
     *        from-genesis replay reproduces the historical accept-below verdict.
     *        Defaults to true for author-facing callers (SDK linter, unit tests).
     * @returns {{ valid: boolean, error?: string }}
     */
    validateSyntax(code, opts) {
        return validateSyntax(code, opts);
    }

    /**
     * Check for floating-point usage warnings.
     * @param {string} code
     * @returns {string[]}
     */
    checkFloatWarnings(code) {
        return checkFloatWarnings(code);
    }

    /**
     * Read a contract's declared permissions manifest (Phase E) at deploy time.
     * Instantiates the module top-level inside an isolate (gas-metered, no state,
     * oracle, or balances) and surfaces its exported `permissions` + `maxTakeBps`
     * WITHOUT dispatching a method, deterministic across validators because it
     * depends only on the (immutable) contract code and the pinned runtime. Works
     * for constructor-less contracts, which vm.execute() never runs otherwise.
     *
     * Returns the raw, typed manifest report; the indexer (actions/deploy.js) owns
     * all validation + fail-closed rejection. On a module-level throw, success is
     * false and the host treats the contract as declaring no manifest (today's
     * behavior for a contract that only fails at first execute).
     *
     * @param {string} code
     * @returns {Promise<{ success: boolean, manifest: object|null, error: string|null }>}
     */
    async readManifest(code) {
        const result = await this.execute({ code, method: '__manifest__', readManifest: true });
        if (!result.success)
            return { success: false, manifest: null, error: result.error };
        let manifest = null;
        try { manifest = JSON.parse(result.returnValue); } catch (e) { manifest = null; }
        return { success: true, manifest, error: null };
    }
}

module.exports = XChainVM;
// Expose the canonical code-size cap so the cross-service regression suite can
// assert it has not drifted from the protocol constant.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;
// Cross-contract call protocol constants (canonical:
// xchain-documentation/protocol/constants.js) for the same reason.
module.exports.MAX_CALL_DEPTH = MAX_CALL_DEPTH;
module.exports.MIN_CALL_GAS   = MIN_CALL_GAS;
// Intra-contract recursion bound (deterministic in-isolate stack-depth limit).
module.exports.MAX_STACK_DEPTH = MAX_STACK_DEPTH;
// Coordinated flag-day (block time) that activates the F3-binary allocation gas
// metering fleet-wide. Exposed so the consensus-params freeze guard can pin it,
// the value is consensus-critical (a divergent flag day forks the fleet).
module.exports.BINARY_ALLOC_GATE_BLOCK_TIME = BINARY_ALLOC_GATE_BLOCK_TIME;
// Coordinated flag-day (block time) that activates the async/Promise contract
// surface change (Promise strip + banned-async deploy rejection) fleet-wide.
// Exposed so the consensus-params freeze guard can pin it; consensus-critical.
module.exports.ASYNC_SURFACE_GATE_BLOCK_TIME = ASYNC_SURFACE_GATE_BLOCK_TIME;
// Cross-CHAIN call (XCALL) protocol constants, same canonical source.
module.exports.XCALL_MIN_GAS             = XCALL_MIN_GAS;
module.exports.XCALL_MAX_GAS             = XCALL_MAX_GAS;
module.exports.XCALL_MAX_HOPS            = XCALL_MAX_HOPS;
module.exports.XCALL_MIN_DEADLINE_BLOCKS = XCALL_MIN_DEADLINE_BLOCKS;
module.exports.XCALL_MAX_DEADLINE_BLOCKS = XCALL_MAX_DEADLINE_BLOCKS;
module.exports.XCALL_MAX_RETURN_BYTES    = XCALL_MAX_RETURN_BYTES;
// Expose the pinned consensus runtime + checker so the indexer (and any
// validator process bundling the VM) can gate the engine version it runs on.
const consensusRuntime = require('./consensus-runtime.js');
module.exports.CONSENSUS_RUNTIME = consensusRuntime.PINNED;
module.exports.CONSENSUS_VERSION = consensusRuntime.CONSENSUS_VERSION;
module.exports.CONSENSUS_STATUS_TOKENS = consensusRuntime.CONSENSUS_STATUS_TOKENS;
module.exports.STATUS_ERROR_PREFIXES = consensusRuntime.STATUS_ERROR_PREFIXES;
module.exports.checkConsensusRuntime = consensusRuntime.checkConsensusRuntime;
module.exports.describeRuntimeMismatch = consensusRuntime.describeMismatch;
// Expose HostFaultError so a host that cannot run contracts (permanently broken
// subprocess executor) is recognisable by callers. They must HALT, not commit
// a fabricated result that would fork the chain.
module.exports.HostFaultError = require('./errors.js').HostFaultError;
// Expose the FROZEN deploy/execution contract surface so the consensus-params
// freeze guards (VM determinism suite + indexer cross-repo coupling test) can
// digest it: the sandbox strip set and the deploy validator's CONSENSUS_RULES.
// Any change to either must bump CONSENSUS_VERSION + re-golden in lockstep.
module.exports.STRIPPED_GLOBAL_NAMES = require('./sandbox.js').STRIPPED_GLOBAL_NAMES;
module.exports.CONSENSUS_RULES = require('./lint-core.js').CONSENSUS_RULES;
// The sandbox neuters more than the global deletes: prototype-method strips
// (regex + locale/ICU), the prototype .constructor neuters, and the SafeMath
// member whitelist are each consensus-critical surface. Expose them frozen so the
// same guards digest them too; otherwise an edit to one of those lists changes
// consensus behaviour without reddening anything.
module.exports.STRIPPED_PROTO_METHODS = require('./sandbox.js').STRIPPED_PROTO_METHODS;
module.exports.NEUTERED_PROTO_CONSTRUCTORS = require('./sandbox.js').NEUTERED_PROTO_CONSTRUCTORS;
module.exports.SAFE_MATH_MEMBERS = require('./sandbox.js').SAFE_MATH_MEMBERS;
// Fail loudly if any frozen export goes missing (e.g. an internal rename in
// sandbox.js / lint-core.js). Without this, the re-export silently becomes
// undefined and the cross-repo freeze guards that digest it would skip rather
// than redden, defeating the whole point of the surface freeze.
if(!module.exports.STRIPPED_GLOBAL_NAMES)
    throw new Error('xchain-vm: sandbox.js no longer exports STRIPPED_GLOBAL_NAMES (frozen consensus surface)');
if(!module.exports.CONSENSUS_RULES)
    throw new Error('xchain-vm: lint-core.js no longer exports CONSENSUS_RULES (frozen consensus surface)');
if(!module.exports.STRIPPED_PROTO_METHODS)
    throw new Error('xchain-vm: sandbox.js no longer exports STRIPPED_PROTO_METHODS (frozen consensus surface)');
if(!module.exports.NEUTERED_PROTO_CONSTRUCTORS)
    throw new Error('xchain-vm: sandbox.js no longer exports NEUTERED_PROTO_CONSTRUCTORS (frozen consensus surface)');
if(!module.exports.SAFE_MATH_MEMBERS)
    throw new Error('xchain-vm: sandbox.js no longer exports SAFE_MATH_MEMBERS (frozen consensus surface)');
