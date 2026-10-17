/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

// The harness compiled when the per-element meter activation is armed
// (../per_element_meter.js), one rule of select.js.
// The unarmed harness is HARNESS_SOURCE byte for byte:
// contract code can read harness function source with String(fn), and error
// positions depend on harness line numbers, so the unarmed text must not move. The
// armed harness is derived from it here by same-line edits, each matched exactly
// once and carrying the same number of line breaks as the text it replaces, plus
// helper declarations inserted before the closing line, so every pre-existing line
// keeps its number in the armed harness too. A derivation that no longer matches
// the harness throws at load.
//
// What the armed rules charge (1 gas = 1 VM_COMPUTATION):
//   - Iterator.prototype map, filter, flatMap, reduce, forEach, some, every, find:
//     1 per callback invocation, so a native callback (Math.abs) no longer walks the
//     input free of the function-entry charge a contract callback pays;
//   - every value an iterator helper (map, filter, take, drop, flatMap) yields: 1;
//   - Set algebra with an argument that is not a plain Set: size(this) plus the
//     larger of the argument's claimed size and the keys its keys() iterator yields
//     (the legacy charge trusted the claim alone, so a size-0 set-like walked free);
//   - String.raw: the segment count on top of the result length;
//   - object spread and rest: every copied key, not only above __GROW_THRESHOLD.

const { HARNESS_SOURCE } = require('../runtime/harness_source.js');
const { deriveHarness } = require('./derivation.js');

const EDITS = [
    // Object spread literal: charge from the first key.
    ['        if (spread > __GROW_THRESHOLD) __gas(spread);\n        return r;\n    });\n\n' +
        '    // Object spread mixed with a method/accessor',
     '        if (spread > 0) __gas(spread);\n        return r;\n    });\n\n' +
        '    // Object spread mixed with a method/accessor'],
    // Object rest and spread mixed with a method: charge from the first key.
    ['            if (ks.length > __GROW_THRESHOLD) __gas(ks.length);',
     '            if (ks.length > 0) __gas(ks.length);'],
    // The legacy Set algebra charge is replaced by the armed wrappers below.
    ["            var orig = Set.prototype[m];\n            if (typeof orig !== 'function') return;",
     "            var orig = Set.prototype[m];\n            if (typeof orig !== 'function' || __pemArmed) return;"],
    // The legacy String.raw result-length wrapper is replaced by the armed one below.
    ["        if (typeof __stringRaw === 'function') __lockMethod(String, 'raw', function() {",
     "        if (typeof __stringRaw === 'function' && !__pemArmed) __lockMethod(String, 'raw', function() {"],
];

// Inserted before the closing line, after every legacy wrapper is installed. The
// install loops are plain for loops: Array.prototype.forEach is metered by now and
// harness installation must not charge an execution. Wrappers that read this are
// strict, so a primitive receiver reaches the native unboxed.
const HELPERS = `    // ----- per-element meter (armed harness only) -----
    // __pemArmed is read by the edited legacy install lines above, which run before
    // this point; a function declaration is hoisted, so it is already true there.
    function __pemArmed() { return true; }
    var __pemFnProto = __getProto(function() {});
    var __pemCall = __pemFnProto.call.bind(__pemFnProto.call);

    // Iterator helpers: 1 gas per callback invocation and per value a helper yields.
    var __pemIterProto = __getProto(__getProto([][Symbol.iterator]()));
    var __pemTake = __pemIterProto.take;
    var __pemHelperProto = typeof __pemTake === 'function' ? __getProto(__pemCall(__pemTake, [].values(), 0)) : null;
    var __pemHelperNext = __pemHelperProto ? __pemHelperProto.next : null;
    if (typeof __pemHelperNext === 'function') __lockMethod(__pemHelperProto, 'next', function() {
        'use strict';
        __gas(1);
        return __pemCall(__pemHelperNext, this);
    });
    // Callbacks receive exactly the arguments the native passes: (value, counter), or
    // (accumulator, value, counter) for reduce. A non-callable argument reaches the
    // native unchanged so it throws its own TypeError.
    var __pemMeterCallback = function(m) {
        var orig = __pemIterProto[m];
        if (typeof orig !== 'function') return;
        __lockMethod(__pemIterProto, m, m === 'reduce' ? function(fn) {
            'use strict';
            if (typeof fn !== 'function') return orig.apply(this, arguments);
            var w = function(acc, v, c) { __gas(1); return __pemCall(fn, undefined, acc, v, c); };
            return arguments.length < 2 ? __pemCall(orig, this, w) : __pemCall(orig, this, w, arguments[1]);
        } : function(fn) {
            'use strict';
            if (typeof fn !== 'function') return orig.apply(this, arguments);
            return __pemCall(orig, this, function(v, c) { __gas(1); return __pemCall(fn, undefined, v, c); });
        });
    };
    var __pemIterMethods = ['map', 'filter', 'flatMap', 'reduce', 'forEach', 'some', 'every', 'find'];
    for (var __pemI = 0; __pemI < __pemIterMethods.length; __pemI++) __pemMeterCallback(__pemIterMethods[__pemI]);

    // Set algebra. A plain Set argument reports its true size, so it keeps the legacy
    // size(this) + size(other) charge. Any other set-like is charged the legacy amount
    // for its claimed size up front, then 1 per key its keys() iterator yields beyond
    // that claim, so the total is size(this) + max(claim, keys walked). It is read
    // once, in spec order (size, has, keys), and handed to the native as a plain
    // record whose has and keys run with the argument as this. A record that fails
    // validation reaches the native as read, so it throws its own error.
    var __pemSetProto = Set.prototype;
    var __pemSizeDesc = __getOwnDesc(__pemSetProto, 'size');
    var __pemSizeGet = __pemSizeDesc && __pemSizeDesc.get;
    var __pemSetHas = __pemSetProto.has;
    var __pemSetKeys = __pemSetProto.keys;
    var __pemIsPlainSet = function(o) {
        if (o === null || typeof o !== 'object') return false;
        try { __pemCall(__pemSizeGet, o); } catch (e) { return false; }
        if (__getProto(o) !== __pemSetProto) return false;
        if (__pemCall(__hasOwn, o, 'size') || __pemCall(__hasOwn, o, 'has') ||
            __pemCall(__hasOwn, o, 'keys')) return false;
        var d = __getOwnDesc(__pemSetProto, 'size');
        var h = __getOwnDesc(__pemSetProto, 'has');
        var k = __getOwnDesc(__pemSetProto, 'keys');
        return !!(d && d.get === __pemSizeGet && h && h.value === __pemSetHas &&
            k && k.value === __pemSetKeys);
    };
    var __pemCountedKeys = function(other, keysFn, tally) {
        return function() {
            var it = __pemCall(keysFn, other);
            if (it === null || (typeof it !== 'object' && typeof it !== 'function')) return it;
            var nextFn = it.next;
            if (typeof nextFn !== 'function') return { next: nextFn };
            return {
                next: function() {
                    if (++tally.walked > tally.claimed && ++tally.pending === 256) { tally.pending = 0; __gas(256); }
                    return __pemCall(nextFn, it);
                },
                get return() {
                    var r = it.return;
                    if (r == null || typeof r !== 'function') return r;
                    return function() { return __pemCall(r, it); };
                }
            };
        };
    };
    var __pemMeterSetMethod = function(m) {
        var orig = __pemSetProto[m];
        if (typeof orig !== 'function') return;
        __lockMethod(__pemSetProto, m, function(other) {
            'use strict';
            var thisSize;
            try { thisSize = __pemCall(__pemSizeGet, this); }
            catch (e) { return orig.apply(this, arguments); }
            if (__pemIsPlainSet(other)) {
                __allocGas(thisSize + __pemCall(__pemSizeGet, other));
                return __pemCall(orig, this, other);
            }
            if (other === null || (typeof other !== 'object' && typeof other !== 'function')) {
                __allocGas(thisSize);
                return __pemCall(orig, this, other);
            }
            var rawSize = other.size;
            var claim = typeof rawSize === 'number' ? rawSize : 0;
            __allocGas(thisSize + claim);
            var size = +rawSize;
            if (!(size > -1)) return __pemCall(orig, this, { size: size });
            var hasFn = other.has;
            if (typeof hasFn !== 'function') return __pemCall(orig, this, { size: size, has: hasFn });
            var keysFn = other.keys;
            if (typeof keysFn !== 'function') return __pemCall(orig, this, { size: size, has: hasFn, keys: keysFn });
            var tally = { walked: 0, pending: 0, claimed: claim > 0 ? claim : 0 };
            var record = {
                size: size,
                has: function(k) { return __pemCall(hasFn, other, k); },
                keys: __pemCountedKeys(other, keysFn, tally)
            };
            try {
                return __pemCall(orig, this, record);
            } finally {
                if (tally.pending > 0) { var left = tally.pending; tally.pending = 0; __gas(left); }
            }
        });
    };
    var __pemSetMethods = ['union', 'intersection', 'difference', 'symmetricDifference',
        'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'];
    for (var __pemS = 0; typeof __pemSizeGet === 'function' && __pemS < __pemSetMethods.length; __pemS++) {
        __pemMeterSetMethod(__pemSetMethods[__pemS]);
    }

    // String.raw: follows the spec steps (one read of raw and of its length, then each
    // segment and substitution converted in order); charges the segment count before
    // the loop and the result length after it.
    var __pemObject = Object;
    var __pemString = String;
    var __pemToString = function(v) { return typeof v === 'symbol' ? '' + v : __pemString(v); };
    var __pemRaw = String.raw;
    if (typeof __pemRaw === 'function') __lockMethod(String, 'raw', function(template) {
        if (template == null) return __pemRaw.apply(this, arguments);
        var rawVal = __pemObject(template).raw;
        if (rawVal == null) return __pemCall(__pemRaw, __pemString, { raw: rawVal });
        var literals = __pemObject(rawVal);
        var count = +literals.length;
        count = count > 0 ? (count < 9007199254740991 ? count - count % 1 : 9007199254740991) : 0;
        if (count === 0) return '';
        __allocGas(count);
        var r = '', subs = arguments.length - 1;
        for (var i = 0; ; i++) {
            r += __pemToString(literals[i]);
            if (i + 1 === count) break;
            if (i < subs) r += __pemToString(arguments[i + 1]);
        }
        if (__stringResultMeterOn) __allocGas(r.length);
        return r;
    });
    // ----- end per-element meter -----
`;

const LABEL = 'per-element meter';

// This rule alone applied to a harness source (derivation.js).
function buildPerElementMeterHarness(source) {
    return deriveHarness(source, [{ label: LABEL, edits: EDITS, helpers: HELPERS }]);
}

const HARNESS_SOURCE_PER_ELEMENT_METER = buildPerElementMeterHarness(HARNESS_SOURCE);

module.exports = {
    LABEL, EDITS, HELPERS,
    HARNESS_SOURCE_PER_ELEMENT_METER, buildPerElementMeterHarness,
};
