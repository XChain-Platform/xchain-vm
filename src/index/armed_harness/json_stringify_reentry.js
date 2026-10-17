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
 * Armed harness for re-entrant JSON.stringify
 ********************************************************************/
// @ts-nocheck
'use strict';

// The harness compiled when the JSON.stringify re-entry activation is armed
// (../json_stringify_reentry_heights.js), one rule of select.js.
// The unarmed harness is HARNESS_SOURCE byte
// for byte: contract code can read harness function source with String(fn), and
// error positions depend on harness line numbers, so the unarmed text must not
// move. The armed harness is derived from it here by same-line edits, each matched
// exactly once and carrying the same number of line breaks as the text it
// replaces, plus helper declarations inserted before the closing line, so every
// pre-existing line keeps its number in the armed harness too. A derivation that no
// longer matches the harness throws at load.
//
// Why: on the value-hook path the walk keeps its frames in one shared pool
// (__rsfFrames) and hands the native call one shared key list (__rsfForwardList).
// A toJSON, replacer or getter that calls JSON.stringify itself overwrote both, so
// the outer call returned the inner result. The armed wrapper gives each nesting
// level its own pool (reused across calls) and restores the outer pool and list
// when the inner call ends, however it ends. A frame first allocated in a nested
// pool is charged like a copy node, so the gas ceiling binds before the isolate
// memory limit; the outermost pool is charged exactly as before.

const { HARNESS_SOURCE } = require('../runtime/harness_source.js');
const { deriveHarness } = require('./derivation.js');

const EDITS = [
    // Lock the re-entrant wrapper before the legacy lock runs; that later lock then
    // fails inside __lockMethod's own try and leaves this one in place.
    ['        __blockTime >= __JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME);\n',
     '        __blockTime >= __JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME); if (__jsonHookGuardOn) { ' +
        "var __rsfNativeStringify = JSON.stringify; __lockMethod(JSON, 'stringify', __rsfStringifyReentrant); }\n"],
    // Charge a frame first allocated in a nested pool.
    ['            if (!fr) fr = __rsfFrames[fi] = { src: null, isArr: false, keys: null, n: 0, i: 0,\n' +
     '                                              done: 0, out: null, inert: true, pKey: null };\n',
     '            if (!fr) fr = __rsfFrames[fi] = __rsfNewFrame({ src: null, isArr: false, keys: null, n: 0, i: 0,\n' +
     '                                              done: 0, out: null, inert: true, pKey: null });\n'],
];

// Inserted before the closing line. Function declarations are hoisted, so the
// wrapper exists when the edited line above locks it.
const HELPERS = [
    '    // ----- re-entrant JSON.stringify (armed harness only) -----',
    '    var __rsfPools = [__rsfFrames];   // one frame pool per nesting level',
    '    var __rsfNested = 0;              // stringify calls resolving right now',
    '    function __rsfNewFrame(fr) {',
    '        if (__rsfNested > 1) __gasFunc(__RSF_COPY_GAS);',
    '        return fr;',
    '    }',
    '    function __rsfStringifyReentrant(value) {',
    '        var outerFrames = __rsfFrames, outerList = __rsfForwardList, copy, list;',
    '        var pool = __rsfPools[__rsfNested];',
    '        if (pool === undefined) pool = __rsfPools[__rsfNested] = [];',
    '        __rsfFrames = pool; __rsfNested++;',
    '        try {',
    '            copy = __resolveForStringify(value, arguments[1]);',
    '            list = __rsfForwardList;',
    '        } finally {',
    '            __rsfNested--; __rsfFrames = outerFrames; __rsfForwardList = outerList;',
    '        }',
    '        var rr = __rsfNativeStringify.call(this, copy, list, arguments[2]);',
    "        if (typeof rr === 'string') __allocGas(rr.length);",
    '        return rr;',
    '    }',
    '    // ----- end re-entrant JSON.stringify -----',
    '',
].join('\n');

const LABEL = 'stringify re-entry';

// This rule alone applied to a harness source (derivation.js).
function buildStringifyReentryHarness(source) {
    return deriveHarness(source, [{ label: LABEL, edits: EDITS, helpers: HELPERS }]);
}

const HARNESS_SOURCE_STRINGIFY_REENTRY = buildStringifyReentryHarness(HARNESS_SOURCE);

module.exports = { LABEL, EDITS, HELPERS, HARNESS_SOURCE_STRINGIFY_REENTRY, buildStringifyReentryHarness };
