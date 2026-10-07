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
 * XChain VM: harness script, part 1 of 5
 *
 * A contiguous slice of the in-isolate prelude; harness_source.js joins the
 * slices in order.
 ********************************************************************/
// @ts-nocheck

module.exports = `
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
    // Bound the F-NR native sinks below the SMALLEST platform native-overflow onset,
    // independent of how the two flag-days order. __DEPTH_LIMIT rides the
    // per-coin block-HEIGHT Pkg 3 gate while the native guard's activation rides the
    // block-TIME binary-alloc gate, so a coin whose height lags its projected
    // activation could run the guard with the musl-unsafe 512 bound and let a
    // 293..512-deep value fork a musl validator from a glibc one; the host clamps
    // this to min(__DEPTH_LIMIT, MAX_STACK_DEPTH_MUSL) so that window cannot open.
    var __NR_DEPTH_LIMIT = globalThis.__NR_DEPTH_LIMIT;
    var __stackDepth   = 0;
    var __stackPoison  = false;
    // The deterministic stack fault. Its message embeds "call stack" so the host
    // classifier (index.js classifyError) maps it to the frozen out_of_stack
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

    // Coordinated flag-day gate for the ADDITIVE O(n)-copy metering upgrades below
    // (iterable Array.from / TypedArray sources that expose .size or nothing, the
    // flat() flattened-result charge, and the F-NR guard's per-node scan-width
    // charge). Each of these moves gasUsed, so it must flip fleet-wide at the SAME
    // block-time flag-day as F3-binary/globals + F-NR; below it (or when no block
    // time was injected -> __blockTime is 0) the legacy charge replays byte-for-bit,
    // so a from-genesis replay reproduces the historical gas at every height.
    var __meterUpgradeOn = (typeof __blockTime === 'number' &&
        typeof __BINARY_ALLOC_GATE_BLOCK_TIME === 'number' &&
        __blockTime >= __BINARY_ALLOC_GATE_BLOCK_TIME); var __iterMeterOn = globalThis.__ITER_SET_METER_ON === true;
    var __applyLengthMeterOn = globalThis.__APPLY_LENGTH_METER_ON === true;

    var __fill = Array.prototype.fill;
    if (typeof __fill === 'function') __lockMethod(Array.prototype, 'fill', function() {
        __allocGas(this == null ? 0 : this.length); return __fill.apply(this, arguments);
    });
    var __from = Array.from;
    if (typeof __from === 'function') __lockMethod(Array, 'from', function(src) {
        // Array-like with numeric .length: charge before the O(n) copy (legacy path,
        // active from genesis; unchanged below/above the flag day).
        if (src && typeof src.length === 'number') { __allocGas(src.length); return __from.apply(this, arguments); }
        // Iterable sources (Set/Map expose .size, a generator exposes neither) also
        // materialize an O(n) native copy but carry no .length, so the legacy wrapper
        // charged nothing. Meter them at/after the flag day: a Set/Map size is known
        // up front (charge before); an un-sized iterable can only be measured by the
        // realized array (charge after, mirroring the JSON.stringify post-charge).
        if (__meterUpgradeOn) {
            if (src && typeof src.size === 'number') { __allocGas(src.size); return __from.apply(this, arguments); }
            var __r = __from.apply(this, arguments);
            if (__r && typeof __r.length === 'number') __allocGas(__r.length);
            return __r;
        }
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
    var __getProto = Object.getPrototypeOf;
    var __getOwnDesc = Object.getOwnPropertyDescriptor;
    var __ownNames = Object.getOwnPropertyNames;
    var __ownSyms = Object.getOwnPropertySymbols;
    // NOT Object.defineProperty: sandbox.js has already replaced that with
    // undefined by the time this harness runs (getter/setter traps would execute
    // unmetered code), and handed the harness the saved native as
    // globalThis.__defineProperty, captured above as __defProp.
    // Give a metering wrapper the original constructor's STATIC surface without
    // standing the wrapper behind the original on the prototype chain.
    //
    // The wrappers avoid __setProto(Wrapped, Orig), which would resolve the
    // statics by inheriting them from the very object being replaced. That reads
    // as harmless and is not: it builds a constructor whose [[Prototype]] is a
    // shape no built-in has (Uint8Array inheriting from Uint8Array rather than
    // from %TypedArray%, so getPrototypeOf(Uint8Array) !== getPrototypeOf(
    // Int8Array)), and it leaves the wrapper with ZERO own statics, so
    // BYTES_PER_ELEMENT / isView / Symbol.species are invisible to
    // getOwnPropertyNames / getOwnPropertySymbols / hasOwn. Any wrapper that then
    // fails to reach the original (the setPrototypeOf catch below, or a second
    // wrapping pass) loses the whole static surface at once.
    //
    // Instead: inherit from what the ORIGINAL inherits from, and copy the
    // original's own statics across by descriptor, so both the chain and the own
    // surface match the unwrapped built-in. Property READS resolve to the same
    // values either way, so gasUsed is untouched and no flag day is involved.
    var __adoptStatics = function(Wrapped, Orig) {
        var __copyOwn = function(k) {
            // Wrapped already owns name, length and prototype: the prototype is the
            // instanceof-preserving alias set by the caller, and all three are
            // readable from contract code, so copying the original's descriptors
            // over them would move observable values.
            if (k === 'name' || k === 'length' || k === 'prototype') return;
            try {
                var d = __getOwnDesc(Orig, k);
                if (d) __defProp(Wrapped, k, d);
            } catch (e) {}
        };
        try {
            if (typeof __setProto === 'function' && typeof __getProto === 'function') {
                __setProto(Wrapped, __getProto(Orig));
            }
        } catch (e) {}
        try {
            var __ns = __ownNames(Orig);
            for (var __ni = 0; __ni < __ns.length; __ni++) __copyOwn(__ns[__ni]);
        } catch (e) {}
        try {
            if (typeof __ownSyms === 'function') {
                var __ss = __ownSyms(Orig);
                for (var __si = 0; __si < __ss.length; __si++) __copyOwn(__ss[__si]);
            }
        } catch (e) {}
    };
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
            if (typeof a === 'number') { __allocGas(a * bpe); return new Orig(...arguments); }
            if (isTyped && a && typeof a.length === 'number') { __allocGas(a.length * bpe); return new Orig(...arguments); }
            // Iterable copy source without .length (Set/Map expose .size, a generator
            // exposes neither): the TypedArray constructor still materializes a dense
            // O(n) backing store, but the length-only probe above charged nothing.
            // Charge the Set/Map size up front; for an un-sized iterable charge the
            // realized view length after (mirrors the Array.from post-charge). An
            // ArrayBuffer view source is NOT iterable, so it stays uncharged here.
            if (isTyped && a && typeof a.size === 'number') { __allocGas(a.size * bpe); return new Orig(...arguments); }
            if (isTyped && a && typeof Symbol === 'function' && Symbol.iterator &&
                typeof a[Symbol.iterator] === 'function') {
                var __res = new Orig(...arguments);
                if (__res && typeof __res.length === 'number') __allocGas(__res.length * bpe);
                return __res;
            }
            return new Orig(...arguments);
        };
        // Preserve instanceof via the prototype alias, and the static surface
        // (BYTES_PER_ELEMENT, from, of, ArrayBuffer.isView, …) by adopting the
        // original's own statics plus its [[Prototype]].
        Wrapped.prototype = Orig.prototype;
        __adoptStatics(Wrapped, Orig);
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
    // ----- Compute-size gas metering for O(n) GLOBAL functions (F3-globals) -----
    // The G1 block below meters the O(n) Array/String/Object/JSON *methods*, but
    // the standalone global functions that scan or transcode a whole string in
    // native code for one call site were left uncharged: encode/decodeURIComponent,
    // encode/decodeURI, escape/unescape (each ALLOCATES an O(n) transcoded copy)
    // and parseInt/parseFloat (each SCANS the full string). Measured ~66k+
    // char-touches per gas: decodeURIComponent(s) over a 120k-char string looped
    // under a 1 M-gas budget burns ~13.5 s of wall-clock while gasUsed stays at
    // ~540k, so the wall-clock net (per-node maxCpuTimeMs, not a consensus value)
    // is the binding constraint -> a cheap-fee throughput DoS and a timeout-vs-
    // commit divergence across a fleet with heterogeneous CPU-time limits. Charge
    // the argument's string length BEFORE delegating (only for string args, so a
    // numeric parseInt(42) stays free), exactly as F3 does for repeat/fill, so the
    // deterministic gas ceiling binds first. Same flag-day as F3-binary (below):
    // both add native-builtin charges that move gasUsed, so they flip atomically.
    var __meterGlobalFn = function(nm) {
        var orig = globalThis[nm];
        if (typeof orig !== 'function') return;
        __lockMethod(globalThis, nm, function(s) {
            if (typeof s === 'string') __allocGas(s.length);
            return orig.apply(this, arguments);
        });
    };
    var __globalFns = ['encodeURIComponent', 'decodeURIComponent', 'encodeURI',
        'decodeURI', 'escape', 'unescape', 'parseInt', 'parseFloat'];
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
        for (var __gi = 0; __gi < __globalFns.length; __gi++) __meterGlobalFn(__globalFns[__gi]);
    }
    // ----- end F3-binary / F3-globals -----

    // ----- Allocation-size gas metering for collection constructors (Pkg 3, 07669055) -----
    // Set/Map/WeakSet/WeakMap constructors are never wrapped by F3-binary above: the
    // metering code treats them only as measured SOURCES (.size), never as charged
    // SINKS. new Set(bigArr) / new Map(bigEntries) materializes an O(n) native hash
    // table for the flat __gas(1) of the call site (the source array was charged once
    // at build and can be reused indefinitely), so a loop of new Set(arr100k) runs
    // ~100k native inserts per ~3 gas -- the same cheap-gas / expensive-CPU grind, and
    // the heterogeneous per-node maxCpuTimeMs wall-clock fork surface, the F3/G1
    // wrappers exist to close. Charge the source length (array) / size (Set/Map) up
    // front, or the realized .size after for an un-sized iterable, mirroring
    // __meterBinaryCtor; instanceof + species preserved via the prototype alias.
    // CONSENSUS GATE: this moves gasUsed, so it rides the per-coin Pkg 3 bundle HEIGHT
    // flag-day (__PKG3_SANDBOX_ON, host-injected via isPkg3SandboxActive). Below the
    // gate the ctors stay unmetered exactly as pre-activation nodes leave them, so a
    // from-genesis replay reproduces the historical gas bit-for-bit. (Sibling to
    // F3-binary, which rides the block-TIME BINARY_ALLOC gate; this leg rides the
    // Pkg 3 HEIGHT gate per the coordinated bundle, so the two arm on different
    // flag-days -- flagged for the release team.)
    var __meterCollectionCtor = function(nm) {
        var Orig = globalThis[nm];
        if (typeof Orig !== 'function') return;
        var Wrapped = function(a) {
            // First arg is the iterable initializer (values for Set/WeakSet, [k,v]
            // pairs for Map/WeakMap). A sized source (array .length, or a Set/Map
            // .size) is charged up front; an un-sized iterable is charged by the
            // realized .size after (Set/Map results expose .size; Weak* results do
            // not, so an un-sized iterable into a Weak collection is left uncharged --
            // the source iterable is itself already O(n)-charged to have been built).
            if (a && typeof a.length === 'number') { __allocGas(a.length); return new Orig(...arguments); }
            if (a && typeof a.size === 'number') { __allocGas(a.size); return new Orig(...arguments); }
            if (a && typeof Symbol === 'function' && Symbol.iterator &&
                typeof a[Symbol.iterator] === 'function') {
                var __res = new Orig(...arguments);
                if (__res && typeof __res.size === 'number') __allocGas(__res.size);
                return __res;
            }
            return new Orig(...arguments);
        };
        Wrapped.prototype = Orig.prototype;
        __adoptStatics(Wrapped, Orig);
        __lockMethod(Orig.prototype, 'constructor', Wrapped);
        __lockMethod(globalThis, nm, Wrapped);
    };
    if (__PKG3_SANDBOX_ON === true) {
        var __collCtors = ['Set', 'Map', 'WeakSet', 'WeakMap'];
        for (var __cci = 0; __cci < __collCtors.length; __cci++) __meterCollectionCtor(__collCtors[__cci]);
    }
    // ----- end collection-constructor metering -----

    // ----- collection MUTATOR metering -----
    // The Pkg 3 G1 work metered collection CONSTRUCTION and iterable-copy sizing
    // above, and stopped there. Growing a collection afterwards was free:
    //
    //     const s = new Set();          // charged 0 (empty)
    //     while (...) s.add(x);         // charged 0 per element
    //
    // so a contract could allocate without bound one element at a time and pay
    // nothing, which is the exact hole the constructor metering was added to close.
    // 'new Set(bigArray)' was charged and the equivalent loop was not.
    //
    // One unit per call, matching the constructor's __allocGas(size) = 1 per
    // element, so the two routes to an N-element collection cost the same.
    // Deliberately __gas(1) and NOT __allocGas(1): __allocGas filters 'x > 1', so
    // routing a per-element charge through it would charge exactly nothing and
    // reinstate the hole while looking like a fix.
    //
    // Charged per CALL rather than only on growth. A re-add of an existing member
    // does not grow the collection but still performs the hash/lookup, and probing
    // .has() first to decide would both do more work and depend on another wrapped
    // method. Per-call is the deterministic and cheaper choice.
    //
    // UNGATED, departing from the flag-day discipline every other gas-moving change
    // in this file follows (__PKG3_SANDBOX_ON, __meterUpgradeOn). Those gates exist
    // so a from-genesis replay reproduces historical gas bit-for-bit; a coordinated
    // fleet-wide wipe-and-replay event replaces that guarantee with one mandatory
    // rebase, under which every node re-executes all history under these rules and
    // no old prefix survives to be reproduced. Do NOT copy this ungated pattern for`;
