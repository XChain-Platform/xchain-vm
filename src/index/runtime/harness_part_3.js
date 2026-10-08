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
 * XChain VM: harness script, part 3 of 5
 *
 * A contiguous slice of the in-isolate prelude; harness_source.js joins the
 * slices in order.
 ********************************************************************/
// @ts-nocheck

module.exports = `
        // Root: SerializeJSONProperty("", { "": value }), so a root-level
        // toJSON/replacer sees the spec's empty-string key and wrapper holder.
        var v = __rsfResolve({ '': rootValue }, '', rootValue, repFn);
        var rootHooked = __rsfRanHook;
        var kind = __rsfClassify(v);
        if (kind === __RSF_SKIP) return undefined;
        if (kind === __RSF_LEAF) return __rsfLeaf;

        var f, pf, i, key, raw, desc, res, ck;
        // A container a hook just produced must be COPIED when it carries a toJSON of
        // its own: SerializeJSONProperty applies toJSON once per slot, so the native
        // call must not find a second one and apply it again. The null-prototype copy
        // is what makes that true (an inherited toJSON is not copied, and an own
        // callable one serializes to nothing, exactly as the spec walk would).
        pushFrame(v, kind === __RSF_ARR, forceDirty || (rootHooked && __rsfHasToJSON(v)), null);
        while (true) {
            f = __rsfFrames[fi];
            if (f.i >= f.n) {
                res = f.inert ? f.src : f.out;
                fi--;
                if (fi < 0) return res;
                pf = __rsfFrames[fi];
                if (!f.inert) materialize(pf);   // the slot changed -> the holder must be a copy too
                if (pf.out !== null) pf.out[f.pKey] = res;
                pf.done = pf.i;
                continue;
            }

            i = f.i;
            // Read the slot EXACTLY ONCE. A data property is taken from its
            // descriptor (no Get, so no contract code); an accessor, a hole or a
            // PropertyList key the holder lacks is read with a single Get, and the
            // frame materializes because a second read could answer differently.
            if (f.isArr) {
                key = i;
                desc = __hasOwn.call(f.src, i) ? __getOwnDesc(f.src, i) : undefined;
                if (desc !== undefined && desc.get === undefined && desc.set === undefined) raw = desc.value;
                else { materialize(f); raw = f.src[i]; }
            } else {
                key = f.keys[i];
                desc = __hasOwn.call(f.src, key) ? __getOwnDesc(f.src, key) : undefined;
                if (desc !== undefined && desc.get === undefined && desc.set === undefined) raw = desc.value;
                else { materialize(f); raw = f.src[key]; }
            }

            res = __rsfResolve(f.src, key, raw, repFn);
            var slotHooked = __rsfRanHook;
            if (slotHooked) materialize(f);
            ck = __rsfClassify(res);
            if (__rsfUnwrapped) materialize(f);

            if (ck === __RSF_ARR || ck === __RSF_OBJ) {
                f.i = i + 1;
                // See the root push: a hook result carrying its own toJSON must be
                // copied so the native call cannot apply that toJSON a second time.
                pushFrame(res, ck === __RSF_ARR, forceDirty || (slotHooked && __rsfHasToJSON(res)), key);
                continue;
            }
            if (f.out !== null) {
                if (ck === __RSF_SKIP) { if (f.isArr) f.out[i] = null; }   // objects elide
                else f.out[key] = __rsfLeaf;
            }
            f.i = i + 1; f.done = i + 1;
        }
    };
    // ----- end F-NR -----

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
        getPollResult: wrap(globalThis.__getPollResult),

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
            vote:      wrap(globalThis.__emit_vote),
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
    // join/flat are handled by dedicated wrappers below (they recurse into nested
    // arrays in native code, so they additionally get the structural-depth guard).
    ['indexOf', 'lastIndexOf', 'includes', 'reverse',
     'slice', 'copyWithin', 'splice', 'unshift', 'shift',
     'toReversed', 'toSpliced', 'with'].forEach(function(m) { __meterLen(Array.prototype, m); });
    // sort/toSorted with the DEFAULT comparator do O(n log n) native compares, each
    // ToString-converting its operands, so the real cost is O(n log n * L) while the
    // flat __meterLen charge above bills O(n) element count only. With a USER
    // comparator every compare runs metered contract code, so the O(n) charge stays
    // correct there. At/after the flag day the default-comparator path charges
    // n*ceil(log2 n) (the compare count) plus one full pass of string-element bytes
    // (the ToString volume; string lengths are read without coercing, so no contract
    // toString fires that the sort itself would not). Deterministic integer math,
    // identical on every node. Below the gate the element-count charge replays
    // byte-for-bit.
    var __msort = function(name) {
        var orig = Array.prototype[name];
        if (typeof orig !== 'function') return;
        __lockMethod(Array.prototype, name, function(cmp) {
            var n = (this == null ? 0 : this.length);
            if (__meterUpgradeOn && typeof cmp !== 'function' && n > 1) {
                var lg = 0, m = 1;
                while (m < n) { m *= 2; lg++; }
                var bytes = 0;
                for (var i = 0; i < n; i++) {
                    var v = this[i];
                    if (typeof v === 'string') bytes += v.length;
                }
                __allocGas(n * lg + bytes);
            } else {
                __allocGas(n);
            }
            return orig.apply(this, arguments);
        });
    };
    __msort('sort');
    __msort('toSorted');
    // join recurses into nested-array elements (and backs Array.prototype.toString,
    // String(arr), arr + empty-string, template interpolation); flat recurses to its
    // depth argument. Guard the
    // structural depth (F-NR) BEFORE delegating, then charge length like __meterLen.
    var __ajoin = Array.prototype.join;
    if (typeof __ajoin === 'function') __lockMethod(Array.prototype, 'join', function() {
        __guardNativeDepth(this);
        // The legacy charge bills the ELEMENT COUNT, but join's real cost scales
        // with the total converted output (200 joins of a 2k-element array of 100-char
        // strings built ~400k chars of output for ~1k gas). join also backs
        // Array.prototype.toString / String(arr) / arr+'' / template interpolation,
        // so the undercharge was reachable from every string-coercion path. At/after
        // the flag day charge the RETURNED STRING's length (mirrors the JSON.stringify
        // post-charge and the flat() upgrade above): the output is bounded by the gas
        // paid for it. Below the gate the element-count charge replays byte-for-bit.
        if (__meterUpgradeOn) {
            var __r = __ajoin.apply(this, arguments);
            if (typeof __r === 'string') __allocGas(__r.length);
            return __r;
        }
        __allocGas(this == null ? 0 : this.length);
        return __ajoin.apply(this, arguments);
    });
    var __aflat = Array.prototype.flat;
    if (typeof __aflat === 'function') __lockMethod(Array.prototype, 'flat', function() {
        __guardNativeDepth(this);
        // The legacy charge bills only the OUTER length, so [bigInner].flat() copies
        // bigInner's elements (the flattened result) for ~0 gas. At/after the flag day
        // charge the FLATTENED result length (mirrors the JSON.stringify post-charge):
        // a reuse loop trips out_of_gas after one pass, a single pass is bounded by the
        // gas already paid to build the source. Below the gate the outer-length charge
        // replays byte-for-bit.
        if (__meterUpgradeOn) {
            var __r = __aflat.apply(this, arguments);
            if (__r && typeof __r.length === 'number') __allocGas(__r.length);
            return __r;
        }
        __allocGas(this == null ? 0 : this.length);
        return __aflat.apply(this, arguments);
    });
    // String: native scan / copy (regex literals are banned at deploy time; the
    // locale-sensitive case methods are neutered in sandbox.js). repeat/padStart/
    // padEnd are owned by F3. Every method listed here has output bounded BY the
    // receiver, so the receiver-length charge is the real work; replace/replaceAll
    // do not and get the dedicated output-aware wrappers below.
    ['indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'slice',
     'substring', 'substr', 'split', 'trim',
     'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].forEach(function(m) { __meterLen(String.prototype, m); });

    // replace/replaceAll are the one String pair whose OUTPUT can exceed the
    // receiver: output = receiver + matches * (replacement - search), and
    // replaceAll substitutes EVERY match, so a 1k-char receiver with 1k matches and
    // a 1k-char replacement materializes ~1 MB for the ~1k gas the receiver-length
    // charge bills. A reuse loop then reaches the per-node wall-clock net (not a
    // consensus value) before the deterministic gas ceiling, so success-vs-resource-
    // failure becomes host-dependent: the same divergence the join/flat/stringify
    // output-aware charges close. At/after the flag day charge
    // max(receiver, result): the max keeps the receiver SCAN billed when the
    // replacement shrinks the string, and the result term bounds the expansion by
    // the gas paid for it. Charged AFTER the native pass, identical to
    // join/flat/JSON.stringify -- one pass runs before out_of_gas, and that pass is
    // itself bounded by the gas already paid to build the receiver. Below the gate
    // the legacy receiver-length charge replays byte-for-bit.
    var __mreplace = function(name) {
        var orig = String.prototype[name];
        if (typeof orig !== 'function') return;
        __lockMethod(String.prototype, name, function() {
            var n = (this == null ? 0 : this.length);
            if (__meterUpgradeOn) {
                var __r = orig.apply(this, arguments);
                __allocGas(typeof __r === 'string' && __r.length > n ? __r.length : n);
                return __r;
            }
            __allocGas(n);
            return orig.apply(this, arguments);
        });
`;
