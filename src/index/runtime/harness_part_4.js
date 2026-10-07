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
 * XChain VM: harness script, part 4 of 5
 *
 * A contiguous slice of the in-isolate prelude; harness_source.js joins the
 * slices in order.
 ********************************************************************/
// @ts-nocheck

module.exports = `    };
    __mreplace('replace');
    __mreplace('replaceAll');

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
        if (typeof __jstr === 'function') __lockMethod(JSON, 'stringify', function(value) {
            if (__jsonHookGuardOn) {
                // Resolve toJSON/replacer/accessors ONCE, depth-check what they
                // actually produced, and serialize THAT. A replacer FUNCTION is
                // deliberately not forwarded: it has already been applied, and running
                // it twice would be both wrong and another way past the depth
                // measurement. A replacer ARRAY runs no contract code, so it is
                // forwarded when the value came through inert and the native call
                // still owes the key filtering (__rsfPassReplacer).
                var copy = __resolveForStringify(value, arguments[1]);
                var rr = __jstr.call(this, copy, __rsfForwardList, arguments[2]);
                if (typeof rr === 'string') __allocGas(rr.length);
                return rr;
            }
            __guardNativeDepth(value);   // native recursion sink (F-NR)
            var r = __jstr.apply(this, arguments);
            if (typeof r === 'string') __allocGas(r.length);
            return r;
        });
        var __jparse = JSON.parse;
        // Captured before contract code runs, so repointing globalThis.String
        // cannot redirect the coercion the guard below depends on.
        var __String = String;
        if (typeof __jparse === 'function') __lockMethod(JSON, 'parse', function(text) {
            if (typeof text === 'string') {
                __allocGas(text.length);
                __guardParseDepth(text);         // native recursion sink (F-NR)
                return __jparse.apply(this, arguments);
            }
            // JSON.parse applies ToString to a non-string argument, so an object
            // with a toString() returning a deep spine reaches the native parser
            // with the string-typed guard above never firing. Coerce ONCE here
            // (String() is ToString with the same string hint, for everything
            // except a symbol, which is left alone so the native call still
            // throws its own TypeError), then guard and parse the coerced text.
            // Only primitives that cannot contain a bracket skip the coercion.
            if (__nrGuardOn && text !== null
                && (typeof text === 'object' || typeof text === 'function')) {
                var s = __String(text);
                __allocGas(s.length);
                __guardParseDepth(s);
                return __jparse.call(this, s, arguments[1]);
            }
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

    // ----- TypedArray prototype O(n) compute metering (G1-TA), flag-gated -----
    // The G1 wrappers above bind the O(n) Array.prototype/String.prototype methods,
    // but TypedArrays (Uint8Array, Float64Array, ...) do NOT inherit Array.prototype:
    // their sort/reverse/copyWithin/indexOf/set/... are the native %TypedArray%.prototype
    // versions, left uncharged by BOTH G1 (Array/String only) and F3-binary (which meters
    // the CONSTRUCTORS, i.e. the one-time backing-store allocation, not the methods). So a
    // contract could do new Uint8Array(n) once (charged once) then loop t.sort() / t.reverse()
    // / t.copyWithin(0,1) for ~2 gas per O(n)/O(n log n) native pass: the same cheap-gas /
    // expensive-CPU grind, and the same timeout-vs-commit fork surface across a fleet with
    // heterogeneous per-node maxCpuTimeMs (not a consensus value), that G1 exists to close.
    // Meter the shared %TypedArray% prototype with the identical __meterLen / sort cost model.
    // CONSENSUS GATE: these methods carried NO historical charge, so any charge here moves
    // gasUsed. Gate on the SAME binary-alloc flag-day as F3-binary (__meterUpgradeOn): below
    // it (or when no block time was injected) the methods stay unmetered exactly as
    // pre-activation nodes leave them, so a from-genesis replay reproduces the historical gas
    // bit-for-bit; at/after it every node charges identically, atomically with the binary
    // constructor/global charges it rides alongside.
    if (__meterUpgradeOn && typeof Uint8Array === 'function') {
        // %TypedArray%.prototype: the single prototype every typed-array kind shares.
        var __TAProto = Object.getPrototypeOf(Uint8Array.prototype);
        if (__TAProto && __TAProto !== Object.prototype) {
            // Native scan / copy / in-place O(n) methods that take no per-element callback
            // (map/filter/forEach/reduce/... are callback-metered, excluded; set/sort get the
            // dedicated wrappers below). fill's backing store was charged once at construction,
            // but an in-place refill is fresh O(n) work, so it is metered here too. subarray is
            // intentionally OMITTED: it returns an O(1) view over the same buffer (no copy), so
            // a length charge would over-bill work that never runs. join is OMITTED too:
            // it is the one method here whose output is not bounded by the element count
            // (each element renders up to ~24 chars, plus a caller-chosen separator per
            // gap), so it gets the output-aware wrapper below, mirroring Array.join.
            ['indexOf', 'lastIndexOf', 'includes', 'reverse', 'slice', 'copyWithin',
             'fill', 'toReversed', 'with'].forEach(function(m) { __meterLen(__TAProto, m); });
            // join(sep) builds a string whose length is the rendered element bytes plus
            // (n-1) separators, so an element-count charge bills O(n) for O(output) native
            // work: new Uint32Array(n).join('x'.repeat(k)) is ~n*k chars for n gas, the same
            // cheap-gas/expensive-CPU grind the Array.join upgrade closes. Charge the
            // RETURNED string's length (never below the element count: every element
            // renders at least one char). No flag branch: this whole block is already
            // inside the __meterUpgradeOn gate, so below it join stays unmetered exactly
            // as pre-activation nodes leave it and replay is byte-identical.
            var __tajoin = __TAProto.join;
            if (typeof __tajoin === 'function') __lockMethod(__TAProto, 'join', function() {
                var __r = __tajoin.apply(this, arguments);
                if (typeof __r === 'string') __allocGas(__r.length);
                return __r;
            });
            // set(src[, offset]) copies src.length elements into the receiver's existing backing
            // store (no allocation, so F3-binary never saw it). Charge the source length, which
            // is the actual O(n) work.
            var __taset = __TAProto.set;
            if (typeof __taset === 'function') __lockMethod(__TAProto, 'set', function(src) {
                __allocGas(src && typeof src.length === 'number' ? src.length : 0);
                return __taset.apply(this, arguments);
            });
            // sort/toSorted with the DEFAULT comparator do O(n log n) native NUMERIC compares
            // with no contract callback, so charge the compare count n*ceil(log2 n). Unlike the
            // Array default-sort upgrade there is no ToString byte volume to add (typed-array
            // elements are numbers). A USER comparator runs metered contract code per compare,
            // so the O(n) base charge is correct there, mirroring __msort exactly.
            var __tasort = function(name) {
                var orig = __TAProto[name];
                if (typeof orig !== 'function') return;
                __lockMethod(__TAProto, name, function(cmp) {
                    var n = (this == null ? 0 : this.length);
                    if (typeof cmp !== 'function' && n > 1) {
                        var lg = 0, m = 1;
                        while (m < n) { m *= 2; lg++; }
                        __allocGas(n * lg);
                    } else {
                        __allocGas(n);
                    }
                    return orig.apply(this, arguments);
                });
            };
            __tasort('sort');
            __tasort('toSorted');
        }
    }
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
    // PRE-GATE form (L-3). The metering pass evaluates obj and k once at the call
    // site; this helper does the read/charge/write so a computed/complex lhs
    // (which can't be safely re-read in place) is byte-metered like __concat.
    // Because b is an ordinary argument it is evaluated BEFORE this body reads
    // obj[key], so when b mutates obj[key] the read observes the post-mutation
    // value: a divergence from the spec, which reads obj[key] (old value) BEFORE
    // evaluating the rhs. Preserved verbatim below METERING_EVAL_ORDER_GATE_BLOCK_TIME
    // so historical results replay byte-identically; the spec-correct order is
    // __setconcatL, emitted only when the gate is active.
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

    // POST-GATE form (L-3): spec-correct left-object evaluation for obj[k] += rhs.
    // The metering pass evaluates obj and k once at the call site (arguments 1-2)
    // and passes the rhs as a THUNK (argument 3, an arrow so this/arguments stay
    // lexical) so it is NOT evaluated at the call site. This body reads obj[key]
    // (the OLD value) FIRST, then invokes the thunk to evaluate rhs, matching the
    // language order: LeftHandSide reference, GetValue(old), then evaluate rhs.
    // A contract where rhs mutates obj[key] now sees the pre-mutation value, as the
    // spec requires. Charging is identical to __setconcat. Emitted only when the
    // gate is active (isMeteringEvalOrderActive); consensus-visible, so gated.
    __lockGlobal('__setconcatL', function(obj, key, rhsThunk) {
        var a = obj[key];
        var b = rhsThunk();
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
`;
