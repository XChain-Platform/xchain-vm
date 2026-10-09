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
 * XChain VM: harness script, part 5 of 5
 *
 * A contiguous slice of the in-isolate prelude; harness_source.js joins the
 * slices in order.
 ********************************************************************/
// @ts-nocheck

module.exports = `    // Array spread  [a, ...x, b]  ->  __arrspread([['e',a], ['s',x], ['e',b]])
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
            } else if (kind === 'h') {
                // Array hole: extend the result by one empty slot so it stays sparse,
                // matching [a, , b] semantics. No data is copied, so no gas is charged
                // for the hole itself (only spread sources cost gas).
                r.length = r.length + 1;
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

    // Object spread mixed with a method/accessor  {...x, m(){}}  keeps its literal
    // form (so the method/getter this-binding and lazy-evaluation semantics are
    // untouched) and instead wraps each spread SOURCE as __objspreadmeter(x). This
    // charges by the source's own-key count (the same O(n) copy __objspread bills)
    // and returns the source unchanged, so the native spread that follows is no
    // longer free.
    __lockGlobal('__objspreadmeter', function(val) {
        if (val != null) {
            var ks = __okeys(val);
            if (ks.length > __GROW_THRESHOLD) __gas(ks.length);
        }
        return val;
    });
    // ----- end G4 -----

    // ----- Native iteration and string metering (gated) -----
    if (__iterMeterOn) {
        var __sizeOf = function(o) {
            var s = o == null ? 0 : o.size;
            return typeof s === 'number' ? s : 0;
        };
        ['isWellFormed', 'toWellFormed'].forEach(function(m) { __meterLen(String.prototype, m); });
        ['union', 'intersection', 'difference', 'symmetricDifference',
         'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'].forEach(function(m) {
            var orig = Set.prototype[m];
            if (typeof orig !== 'function') return;
            __lockMethod(Set.prototype, m, function(other) {
                __allocGas(__sizeOf(this) + __sizeOf(other));
                return orig.apply(this, arguments);
            });
        });
        var __iterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
        var __iterToArray = __iterProto.toArray;
        if (typeof __iterToArray === 'function') __lockMethod(__iterProto, 'toArray', function() {
            var r = __iterToArray.apply(this, arguments);
            if (r && typeof r.length === 'number') __allocGas(r.length);
            return r;
        });
        var __iterDrop = __iterProto.drop;
        if (typeof __iterDrop === 'function') __lockMethod(__iterProto, 'drop', function(count) {
            var c = +count;
            if (c > 0) __allocGas(c);
            return __iterDrop.apply(this, arguments);
        });
    }
    if (__applyLengthMeterOn) {
        // Callback bodies meter present elements, but these methods skip holes in
        // native code. A sparse or generic array-like receiver can therefore scan
        // an arbitrarily large length without running any metered callback code.
        // Charge the snapshotted receiver length after the native call, including
        // a callback throw that contract code could otherwise catch and repeat.
        // This shares the apply-length flag because both close length-driven native
        // work that was previously billed only at the flat call-site rate.
        var __meterSparseCallback = function(name) {
            var orig = Array.prototype[name];
            if (typeof orig !== 'function') return;
            __lockMethod(Array.prototype, name, function() {
                var n = (this == null ? 0 : this.length);
                try {
                    return orig.apply(this, arguments);
                } finally {
                    __allocGas(n);
                }
            });
        };
        ['every', 'filter', 'flatMap', 'forEach', 'map', 'reduce',
         'reduceRight', 'some'].forEach(__meterSparseCallback);

        var __fnProto = Object.getPrototypeOf(function() {});
        var __applyNative = __fnProto.call.bind(__fnProto.apply);
        __lockMethod(__fnProto, 'apply', function(thisArg, args) {
            if (args != null && typeof args.length === 'number' && args.length > __GROW_THRESHOLD) __gas(args.length);
            return __applyNative(this, thisArg, args);
        });
        // resize/transfer allocate (and zero or copy) a new backing store sized by
        // their argument, so charge that byte length the way the constructor does.
        // The argument is coerced once here and the number handed to the native, so
        // a valueOf hook runs a single time.
        var __abProto = typeof ArrayBuffer === 'function' ? ArrayBuffer.prototype : null;
        var __abLenDesc = __abProto ? __getOwnDesc(__abProto, 'byteLength') : null;
        var __abLenGet = __abLenDesc && __abLenDesc.get;
        ['resize', 'transfer', 'transferToFixedLength'].forEach(function(m) {
            var orig = __abProto ? __abProto[m] : null;
            if (typeof orig !== 'function') return;
            __lockMethod(__abProto, m, function(newLen) {
                var n = newLen;
                if (n !== undefined) n = +n;
                else if (m !== 'resize' && typeof __abLenGet === 'function') {
                    try { n = __abLenGet.call(this); } catch (e) { n = 0; }
                }
                __allocGas(n);
                return n === undefined ? orig.call(this) : orig.call(this, n);
            });
        });
    }
    // ----- end native metering -----
})();
`;
