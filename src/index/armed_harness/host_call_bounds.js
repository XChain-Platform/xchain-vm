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

// The harness compiled when the host-call bounds activation is armed
// (../host_call_bounds.js), one rule of select.js.
// The unarmed harness is HARNESS_SOURCE exactly as it was:
// contract code can read harness function source with String(fn), and a
// host-thrown error's stack text carries a harness line and column, so the unarmed
// text must not move by a byte. The armed harness is derived from it here:
//   - a fixed list of same-line edits, each matched exactly once and carrying the
//     same number of line breaks as the text it replaces, so every pre-existing
//     line keeps its line number in the armed harness too;
//   - helper declarations inserted before the closing line of the harness.
// A derivation that no longer matches the harness text throws at load, so a
// harness edit elsewhere cannot silently drop one of these rules.
//
// What the armed rules do:
//   - cyclic values: on the JSON.stringify path both F-NR walkers (the value-hook
//     walk and the plain value guard) check each object against the objects above
//     it and throw a catchable TypeError with a fixed message, instead of running
//     the cycle to the depth limit and faulting out_of_stack at the gas ceiling. A
//     shared reference on two branches is not a cycle. join and flat keep their
//     depth fault;
//   - host-call argument depth: wrap() serializes a host call's arguments inside
//     one array the contract did not write, so it lends the depth guards one level
//     for that call. The JSON.stringify wrapper takes and clears the allowance on
//     entry, so a hook that calls JSON.stringify itself gets none.

const { HARNESS_SOURCE } = require('../runtime/harness_source.js');
const { deriveHarness } = require('./derivation.js');

const EDITS = [
    // wrap(): lend one depth level to the argument array for this call only.
    ['            var jsonArgs = JSON.stringify(Array.prototype.slice.call(arguments));',
     '            var argList = Array.prototype.slice.call(arguments), jsonArgs; __hostArgDepthAllowance = 1; ' +
        'try { jsonArgs = JSON.stringify(argList); } finally { __hostArgDepthAllowance = 0; }'],
    // Plain value guard: depth allowance and, on the JSON path, cycle detection.
    ['    var __guardNativeDepth = function(root) {',
     '    var __guardNativeDepth = function(root, allowance, forJson) {'],
    ['        var depths = [1];',
     '        var depths = [1], limit = __NR_DEPTH_LIMIT + (allowance | 0), path = forJson ? [] : null;'],
    ['            if (d > __NR_DEPTH_LIMIT) { __stackPoison = true; throw __stackError(); }',
     '            if (path !== null && __onPath(path, v, d)) throw __cycleError(); ' +
        'if (d > limit) { __stackPoison = true; throw __stackError(); }'],
    // Value-hook walk: depth allowance and cycle detection over the open frames.
    ['    var __resolveForStringify = function(rootValue, replacer) {',
     '    var __resolveForStringify = function(rootValue, replacer, allowance) {'],
    ['        var depthLimit = __NR_DEPTH_LIMIT;',
     '        var depthLimit = __NR_DEPTH_LIMIT + (allowance | 0);'],
    ['            if (fi + 1 > depthLimit) { __stackPoison = true; throw __stackError(); }',
     '            if (__onFrames(src, fi)) throw __cycleError(); ' +
        'if (fi + 1 > depthLimit) { __stackPoison = true; throw __stackError(); }'],
    // JSON.stringify wrapper: take the allowance, clear it, hand it to the guards.
    ["__lockMethod(JSON, 'stringify', function(value) {",
     "__lockMethod(JSON, 'stringify', function(value) { " +
        'var allowance = __hostArgDepthAllowance; __hostArgDepthAllowance = 0;'],
    ['                var copy = __resolveForStringify(value, arguments[1]);',
     '                var copy = __resolveForStringify(value, arguments[1], allowance);'],
    ['            __guardNativeDepth(value);   // native recursion sink (F-NR)',
     '            __guardNativeDepth(value, allowance, true);   // native recursion sink (F-NR)'],
];

// Inserted before the closing line. Function declarations are hoisted, so the
// helpers exist for any call; the two vars are only read at contract run time.
const HELPERS = [
    '    // ----- host-call bounds (armed harness only) -----',
    '    var __hostArgDepthAllowance = 0;',
    '    var __TypeError = TypeError;',
    "    function __cycleError() { return new __TypeError('Converting circular structure to JSON'); }",
    '    // path[0..d-2] holds the objects above a node at depth d; record the node at d-1.',
    '    function __onPath(path, v, d) {',
    '        for (var j = 0; j < d - 1; j++) if (path[j] === v) return true;',
    '        path[d - 1] = v;',
    '        return false;',
    '    }',
    '    // __rsfFrames[0..top-1] are the open frames above the one being pushed.',
    '    function __onFrames(src, top) {',
    '        for (var j = 0; j < top; j++) if (__rsfFrames[j].src === src) return true;',
    '        return false;',
    '    }',
    '    // ----- end host-call bounds -----',
    '',
].join('\n');

const LABEL = 'host-call bounds';

// This rule alone applied to a harness source (derivation.js).
function buildHostCallBoundsHarness(source) {
    return deriveHarness(source, [{ label: LABEL, edits: EDITS, helpers: HELPERS }]);
}

const HARNESS_SOURCE_HOST_CALL_BOUNDS = buildHostCallBoundsHarness(HARNESS_SOURCE);

module.exports = { LABEL, EDITS, HELPERS, HARNESS_SOURCE_HOST_CALL_BOUNDS, buildHostCallBoundsHarness };
