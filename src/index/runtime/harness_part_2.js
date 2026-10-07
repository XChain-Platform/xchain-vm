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
 * XChain VM: harness script, part 2 of 5
 *
 * A contiguous slice of the in-isolate prelude; harness_source.js joins the
 * slices in order.
 ********************************************************************/
// @ts-nocheck

module.exports = `    // a post-launch change: it is correct only inside that rebase.
    var __meterCollectionMutator = function(nm, method) {
        var Ctor = globalThis[nm];
        if (typeof Ctor !== 'function' || !Ctor.prototype) return;
        var Orig = Ctor.prototype[method];
        if (typeof Orig !== 'function') return;
        __lockMethod(Ctor.prototype, method, function() {
            __gas(1);
            return Orig.apply(this, arguments);
        });
    };
    var __collMutators = [['Set', 'add'], ['Map', 'set'], ['WeakSet', 'add'], ['WeakMap', 'set']];
    for (var __cmi = 0; __cmi < __collMutators.length; __cmi++)
        __meterCollectionMutator(__collMutators[__cmi][0], __collMutators[__cmi][1]);
    // ----- end collection-mutator metering -----

    // ----- Deterministic structural-depth guard for native-recursive builtins (F-NR) -----
    // JSON.stringify and Array.prototype.join/flat (join also backs toString,
    // String(arr), arr+empty-string, and template interpolation of an array)
    // recurse in native C++ down to the value's NESTING depth. That native
    // recursion bypasses the __depth_enter meter, which
    // only wraps contract JS frames, so its only backstop is V8's native stack
    // limit. isolated-vm derives that limit from the HOST THREAD stack
    // (environment.cc AsyncEntry: SetStackLimit(GetStackBase()+24KB)), which its own
    // comment notes is 512KB per pthread on macOS versus ~2MB on Linux (and ~128KB
    // on musl/Alpine). So a value nested past that depth overflows at a
    // HOST-DEPENDENT depth. A contract can build such a spine with a cheap loop
    // (a=[a]; a plain loop, no recursion, so no __depth_enter charge), feed it to one
    // of these sinks, CATCH the RangeError, and branch on caught-vs-not: divergent
    // hashed state across a heterogeneous-OS fleet (the same fork class the
    // __depth_enter/__DEPTH_LIMIT guard closes for contract recursion, left open on
    // the native-builtin path). Pre-check nesting depth against the SAME
    // platform-independent __DEPTH_LIMIT, ITERATIVELY (explicit stack, never
    // recurses, so the guard itself cannot overflow), and route an over-depth value
    // into the SAME un-swallowable __stackPoison the recursion guard uses: once
    // poisoned every metered __gas point re-throws, so catching the fault cannot
    // resume, and the collapsed out_of_stack outcome is identical on every host.
    // No memo: __gasFunc(1) is charged per node visited, so a shared-reference DAG
    // that unfolds exponentially (a=[a,a]) trips the deterministic gas ceiling
    // (out_of_gas) instead of exploring forever, while a genuine deep spine aborts
    // after ~__DEPTH_LIMIT nodes. CONSENSUS GATE: the extra per-node gas and the
    // poison both move the hashed outcome, so this is active only at/after the same
    // block-time flag-day as F3-binary/globals; below it the guard is inert and the
    // legacy native-recursion behaviour replays unchanged.
    var __hasOwn = Object.prototype.hasOwnProperty;
    var __isArray = Array.isArray;   // captured native (contract cannot repoint the guard)
    var __nrGuardOn = (__meterUpgradeOn && __NR_DEPTH_LIMIT > 0);
    // Second, LATER flag day for the JSON.stringify value-hook half below
    // (__resolveForStringify). It rides its own activation because the binary-alloc
    // flag day above has already passed: blocks executed under it must replay
    // byte-for-byte, so the hook resolution cannot be folded into it. A gate value of
    // 0 means active since genesis; the per-network resolver injected by the host keeps
    // a pre-launch network's activation from changing mainnet replay behaviour.
    var __jsonHookGuardOn = (__nrGuardOn &&
        typeof __blockTime === 'number' &&
        typeof __JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME === 'number' &&
        __blockTime >= __JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME);
    var __guardNativeDepth = function(root) {
        if (!__nrGuardOn) return;
        if (__stackPoison) throw __stackError();
        if (root === null || typeof root !== 'object') return;
        var stack = [root];
        var depths = [1];
        while (stack.length) {
            var v = stack.pop();
            var d = depths.pop();
            __gasFunc(1);                                       // per-node base (DAG / exponential-reuse bound)
            if (d > __NR_DEPTH_LIMIT) { __stackPoison = true; throw __stackError(); }
            var i, c, w;
            // The guard SCANS every child of the popped node (O(width)) to find the
            // object children to recurse into. The flat per-node charge above only
            // bounded DEPTH and node COUNT, not this per-node WIDTH: a wide primitive
            // array referenced N times is popped N times and re-scanned in full each
            // time (no memo), so O(N*width) native scan work ran for O(N) gas -> a
            // timeout-vs-commit fork. Charge the scan width so the guard's CPU work is
            // bounded by the gas paid. Deterministic integer math; every node computes
            // an identical charge.
            if (__isArray(v)) {
                w = v.length;
                if (w > 1) __gasFunc(w);                        // array width known up front -> charge before the scan
                for (i = 0; i < w; i++) {
                    c = v[i];
                    if (c !== null && typeof c === 'object') { stack.push(c); depths.push(d + 1); }
                }
            } else {
                // Object own-key count is only known by enumerating; count during the
                // scan and charge after (mirrors the JSON.stringify/G1 post-charge).
                w = 0;
                for (var k in v) {
                    if (__hasOwn.call(v, k)) {
                        w++;
                        c = v[k];
                        if (c !== null && typeof c === 'object') { stack.push(c); depths.push(d + 1); }
                    }
                }
                if (w > 1) __gasFunc(w);
            }
        }
    };

    // F-NR, deserialization half (JSON.parse). The value guard above cannot be
    // used here: at call time the only thing that exists is the input TEXT, and
    // the recursion happens while (or just after) the native parser builds the
    // value. Two distinct native walks hang off this one sink, and both bottom
    // out on the same HOST-THREAD stack the comment above describes:
    //   - the parser itself, whose recursion depth (V8 versions differ; the
    //     current one carries an explicit continuation stack, older ones recurse)
    //     is not a property this engine may depend on across upgrades, and
    //   - the REVIVER walk (InternalizeJSONProperty), which IS plainly recursive
    //     on every V8 we support: measured on Node 22, JSON.parse(deep, fn)
    //     throws a CATCHABLE RangeError past depth ~290 on a 128KB stack, ~1200
    //     on 512KB and ~4800 on 2MB, i.e. the fault point is the validator's OS
    //     and thread-stack size, not a consensus input. A contract can build the
    //     text with a metered loop, catch, and branch: same fork class, opposite
    //     direction.
    // So bound the NESTING the parser is asked to build, deterministically,
    // before it is asked to build it. The scan is a flat integer walk over the
    // text (never recurses) and is string-literal aware: a bracket inside a JSON
    // string is data, not structure, so '"[[[["' must still parse. Backslash
    // escapes are honoured so an escaped quote does not close the literal early
    // (and a bracket after it is still treated as data). Over-depth
    // input routes into the SAME un-swallowable __stackPoison as every other
    // F-NR sink, so the outcome is an identical out_of_stack on every host.
    // Gas: the caller already charges __allocGas(text.length) BEFORE this runs,
    // and the scan is O(text.length), so the guard's CPU is bounded by gas
    // already paid and adds no charge of its own. That keeps gasUsed byte-equal
    // to the legacy path for every input that is not over-depth; the only
    // consensus-visible move is the deterministic fault itself, which is why
    // this rides the same __nrGuardOn flag-day as the value guard.
    var __guardParseDepth = function(text) {
        if (!__nrGuardOn) return;
        if (__stackPoison) throw __stackError();
        var n = text.length, i = 0, depth = 0, ch;
        while (i < n) {
            ch = text.charCodeAt(i++);
            if (ch === 34) {                       // '"' opens a string literal
                while (i < n) {
                    ch = text.charCodeAt(i++);
                    if (ch === 92) i++;            // backslash escapes the next unit
                    else if (ch === 34) break;     // closing quote
                }
            } else if (ch === 91 || ch === 123) {  // '[' or '{'
                depth++;
                if (depth > __NR_DEPTH_LIMIT) { __stackPoison = true; throw __stackError(); }
            } else if (ch === 93 || ch === 125) {  // ']' or '}'
                if (depth > 0) depth--;
            }
        }
    };

    // ----- F-NR, value-hook half: JSON.stringify's toJSON / replacer / accessor -----
    // __guardNativeDepth above measures the ARGUMENT and then hands the ORIGINAL
    // value to the native serializer, so anything that makes the serializer walk
    // DEEPER than the guard counted re-opens the host-dependent native overflow the
    // guard exists to close:
    //   1. toJSON    - the guard descends only children whose typeof is 'object',
    //                  and a method is typeof 'function', so
    //                  {toJSON:function(){return spine;}} measures as depth 1 and
    //                  serializes as deep as the spine the hook hands back.
    //   2. replacer  - arguments[1] went straight into the native call, so structure
    //                  a replacer FUNCTION returns was never depth-checked at all.
    //   3. accessors - the guard reads v[k] once and the serializer reads it again,
    //                  so an own getter can answer shallow first and deep second.
    // The JSON.parse wrapper already closes the analogous ToString bypass by
    // coercing ONCE and guarding the coerced text. This is that same principle for
    // the value side: run every hook exactly ONCE here, measure the depth of what
    // the hooks actually produced, and hand the native serializer a value that
    // cannot change under it.
    //
    // Shape: one iterative frame-based DFS (never recursive, so the pass itself
    // cannot overflow; frames are pooled by depth, so the walk allocates nothing
    // per node). A node is INERT when the native serializer, walking it, would run
    // no contract code at all: no toJSON anywhere on its prototype chain, no own
    // accessor among the properties that get serialized, no hole an inherited getter
    // could answer, no primitive wrapper to unwrap, and no replacer to apply. An
    // inert subtree is passed through BY REFERENCE and never copied, so a hook-free
    // value takes byte-for-byte the pre-gate path for byte-for-byte the pre-gate gas
    // and allocates nothing: only hook/accessor-bearing values are materialized.
    // Everything not proven inert is REBUILT as a null-prototype plain copy, which is
    // what makes handing it to the native call safe: the copy carries only primitives
    // and other copy nodes, its null prototype means a contract-installed
    // Object.prototype.toJSON / Array.prototype.toJSON cannot re-enter during the
    // native call, and an own "__proto__" key survives as data instead of re-pointing
    // the copy.
    //
    // Deviations from ECMA-262 SerializeJSONProperty, each deterministic on every
    // host and each pinned by the security suite:
    //   - A cyclic structure keeps the behaviour the value guard ALREADY has above
    //     the binary-alloc flag day: the depth counter runs the cycle up to
    //     __NR_DEPTH_LIMIT and takes the deterministic out_of_stack. It deliberately
    //     does not become V8's "Converting circular structure to JSON" TypeError,
    //     whose message embeds constructor names and a property path and is a worse
    //     consensus input than the fault it would replace.
    //   - A primitive-wrapper object whose prototype has been re-pointed to
    //     Object.prototype serializes as a plain object rather than as its wrapped
    //     primitive: the internal-slot probe runs only for objects whose prototype is
    //     neither Object.prototype nor null, so the hot path stays free of throws.
    //     A false POSITIVE there would pass an unmeasured object through by
    //     reference, so the probe is the exact internal-slot brand check and never a
    //     prototype guess; a false negative only costs spec fidelity on a value a
    //     contract had to go out of its way to disguise.
    //   - A replacer ARRAY is re-derived here into a plain string list and THAT list
    //     is what the native call receives, so a replacer array whose elements are
    //     accessors cannot answer this pass one key set and the serializer another.
    var __rsfObjectProto = Object.prototype;
    var __rsfOkeys       = Object.keys;   // raw native; the Object-statics meter wraps Object.keys further down
    var __rsfString      = String;
    var __rsfStrValueOf  = String.prototype.valueOf;
    var __rsfNumValueOf  = Number.prototype.valueOf;
    var __rsfBoolValueOf = Boolean.prototype.valueOf;
    var __rsfBigProto    = (typeof BigInt === 'function' && BigInt.prototype) ? BigInt.prototype : null;
    var __rsfBigValueOf  = __rsfBigProto ? __rsfBigProto.valueOf : null;

    // Gas charged the first time a node is MATERIALIZED, on top of the per-node and
    // per-width charges the inert walk already pays. The copy is an allocation, and
    // the reasoning F3-binary uses for ArrayBuffer byte lengths applies unchanged:
    // the deterministic gas ceiling must bind BEFORE the isolate memory limit, or a
    // hook-bearing structure that unfolds exponentially
    // (a={toJSON:function(){return [a,a];}}) reaches a CATCHABLE allocation failure
    // whose point depends on heap occupancy and GC timing, i.e. exactly the
    // host-dependent fork this guard exists to close. 32 gas/node keeps the copy
    // under the isolate memory ceiling at every gas ceiling in use (an 8 MB limit
    // against a 1e6..3e6 ceiling is 2.7..8 bytes per gas, and a copy node is ~56).
    var __RSF_COPY_GAS = 32;

    var __RSF_SKIP = 0, __RSF_LEAF = 1, __RSF_ARR = 2, __RSF_OBJ = 3;
    var __rsfLeaf      = undefined;  // out-param: the leaf value __rsfClassify accepted
    var __rsfUnwrapped = false;      // out-param: that leaf came out of a primitive wrapper
    var __rsfClassify = function(v) {
        __rsfUnwrapped = false;
        if (v === null) { __rsfLeaf = null; return __RSF_LEAF; }
        var t = typeof v;
        if (t === 'undefined' || t === 'function' || t === 'symbol') return __RSF_SKIP;
        if (t !== 'object') { __rsfLeaf = v; return __RSF_LEAF; }   // string/number/boolean/bigint
        if (__isArray(v)) return __RSF_ARR;
        var p = __getProto(v);
        if (p !== __rsfObjectProto && p !== null) {
            // Only an object carrying the matching internal slot answers these
            // without throwing, so a plain object can never be mistaken for a
            // wrapper. Unwrap to the primitive (SerializeJSONProperty step 4) so the
            // copy holds a primitive rather than a contract object; a wrapped BigInt
            // unwraps to a BigInt and still raises the native TypeError downstream.
            try { __rsfLeaf = __rsfStrValueOf.call(v);  __rsfUnwrapped = true; return __RSF_LEAF; } catch (e) {}
            try { __rsfLeaf = __rsfNumValueOf.call(v);  __rsfUnwrapped = true; return __RSF_LEAF; } catch (e) {}
            try { __rsfLeaf = __rsfBoolValueOf.call(v); __rsfUnwrapped = true; return __RSF_LEAF; } catch (e) {}
            if (__rsfBigValueOf) {
                try { __rsfLeaf = __rsfBigValueOf.call(v); __rsfUnwrapped = true; return __RSF_LEAF; } catch (e) {}
            }
        }
        return __RSF_OBJ;
    };
    // Would the native serializer look up (and possibly call) a toJSON on this value?
    // The 'in' operator never invokes an accessor, so this probe runs no contract
    // code. (NB: this harness is a template literal, so a backtick anywhere in here
    // -- comments included -- would terminate it.)
    var __rsfHasToJSON = function(v) {
        if (v === null) return false;
        var t = typeof v;
        if (t === 'object' || t === 'function') return ('toJSON' in v);
        if (t === 'bigint') return (__rsfBigProto !== null && ('toJSON' in __rsfBigProto));
        return false;
    };
    // The SerializeJSONProperty preamble, applied exactly once per slot and in spec
    // order: value.toJSON(key), then replacer.call(holder, key, value). Sets
    // __rsfRanHook when contract code ran, which is what forces the holder to be
    // materialized (the slot no longer equals what a re-read would return).
    var __rsfRanHook = false;
    var __rsfResolve = function(holder, key, v, repFn) {
        var ran = false;
        if (__rsfHasToJSON(v)) {
            // Presence alone forces materialization: the .toJSON read below can
            // itself be an inherited accessor, and a callable one replaces the value.
            ran = true;
            var tj = v.toJSON;
            if (typeof tj === 'function') { __gasFunc(1); v = tj.call(v, __rsfString(key)); }
        }
        if (repFn !== null) { ran = true; __gasFunc(1); v = repFn.call(holder, __rsfString(key), v); }
        __rsfRanHook = ran;
        return v;
    };
    // JSON.stringify step 4.b.ii: a replacer ARRAY becomes a de-duplicated key
    // filter of String/Number (and wrapped String/Number) elements.
    var __rsfPropertyList = function(replacer) {
        if (replacer === null || typeof replacer !== 'object' || !__isArray(replacer)) return null;
        var len = replacer.length >>> 0;
        if (len > 1) __gasFunc(len);
        var seen = { __proto__: null };
        var list = [], i, v, t, item;
        for (i = 0; i < len; i++) {
            v = replacer[i]; t = typeof v; item = undefined;
            if (t === 'string') item = v;
            else if (t === 'number') item = __rsfString(v);
            else if (t === 'object' && v !== null) {
                try { item = __rsfStrValueOf.call(v); } catch (e) {
                    try { item = __rsfString(__rsfNumValueOf.call(v)); } catch (e2) {}
                }
            }
            if (item !== undefined && seen[item] !== true) { seen[item] = true; list.push(item); }
        }
        return list;
    };
    var __rsfFrames = [];   // pooled by depth: the walk allocates no frame per node
    // Set by __resolveForStringify to the SANITIZED replacer key list (or null). The
    // native call is handed this list rather than the caller's array so that (a) it,
    // not this pass, decides the emitted key order -- a plain object cannot reproduce
    // every order a replacer array can ask for, since integer-like keys always
    // enumerate ascending and first -- and (b) an element that is an accessor cannot
    // answer this pass one key set and the serializer another. Re-applying the list
    // to an already-filtered copy is idempotent: the copy holds exactly these keys.
    var __rsfForwardList = null;
    var __resolveForStringify = function(rootValue, replacer) {
        if (__stackPoison) throw __stackError();
        // Fail closed: without setPrototypeOf a copy cannot be made immune to a
        // contract-installed Array.prototype.toJSON, so take the deterministic fault
        // rather than fall back to the raw native call.
        if (typeof __setProto !== 'function') { __stackPoison = true; throw __stackError(); }

        var repFn      = (typeof replacer === 'function') ? replacer : null;
        var propList   = (repFn === null) ? __rsfPropertyList(replacer) : null;
        // A replacer FUNCTION runs contract code at every slot, so it materializes
        // everything. A replacer ARRAY runs none: it is a pure key filter, so it only
        // narrows the key list this walk measures (which keeps the depth measurement
        // exact rather than conservative) and is forwarded to the native call
        // untouched whenever the value came through inert.
        var forceDirty = (repFn !== null);
        var depthLimit = __NR_DEPTH_LIMIT;
        var fi = -1;
        __rsfForwardList = propList;

        var materialize = function(fr) {
            if (fr.out !== null) return;
            __gasFunc(__RSF_COPY_GAS);
            fr.inert = false;
            if (fr.isArr) { fr.out = []; __setProto(fr.out, null); }
            else { fr.out = { __proto__: null }; }
            // Backfill the inert prefix. Every slot already committed was an
            // unchanged read of an own data property (an accessor, a hole, a hook or
            // a wrapper would have materialized the frame at that slot), so
            // re-reading them runs no contract code and yields identical values.
            var b, bk, bv, bt;
            for (b = 0; b < fr.done; b++) {
                bk = fr.isArr ? b : fr.keys[b];
                bv = fr.src[bk];
                bt = typeof bv;
                if (bt === 'undefined' || bt === 'function' || bt === 'symbol') {
                    if (fr.isArr) fr.out[b] = null;      // arrays encode a skipped slot as null
                    continue;                            // objects elide it
                }
                fr.out[bk] = bv;
            }
        };
        var pushFrame = function(src, isArr, dirty, pKey) {
            fi++;
            var fr = __rsfFrames[fi];
            if (!fr) fr = __rsfFrames[fi] = { src: null, isArr: false, keys: null, n: 0, i: 0,
                                              done: 0, out: null, inert: true, pKey: null };
            fr.src = src; fr.isArr = isArr; fr.i = 0; fr.done = 0;
            fr.out = null; fr.inert = true; fr.pKey = pKey;
            __gasFunc(1);                                        // per-node base (DAG / exponential-reuse bound)
            if (fi + 1 > depthLimit) { __stackPoison = true; throw __stackError(); }
            if (isArr) { fr.keys = null; fr.n = src.length >>> 0; }
            else { fr.keys = (propList !== null) ? propList : __rsfOkeys(src); fr.n = fr.keys.length; }
            if (fr.n > 1) __gasFunc(fr.n);                       // per-node scan width
            if (dirty) materialize(fr);
            return fr;
        };`;
