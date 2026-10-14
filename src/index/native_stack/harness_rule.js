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
 * Armed harness rule for the native stack activation
 ********************************************************************/
// @ts-nocheck
'use strict';

// Used when the native stack activation is armed (activation.js). The hooks of
// harness_hooks.js are joined onto the depth-state line, and each install site
// (__gas, __depth_enter, __depth_exit, __arrspread) picks the armed hook on its
// own line, so no harness line moves. The hooks read __NATIVE_STACK_TERMINAL_ON,
// which isolate_globals.js injects only while the activation is armed.

const { NATIVE_STACK_LINE } = require('./harness_hooks.js');

const LABEL = 'native stack terminal';

const EDITS = [
    ['    var __stackPoison  = false;\n',
     '    var __stackPoison  = false; ' + NATIVE_STACK_LINE + '\n'],
    ['        value: __gasFunc,\n',
     '        value: __nstOn ? __nstGas : __gasFunc,\n'],
    ["    __defProp(globalThis, '__depth_enter', {\n        value: function() {\n",
     "    __defProp(globalThis, '__depth_enter', {\n        value: __nstOn ? __nstDepthEnter : function() {\n"],
    ['        value: function() { if (__stackDepth > 0) __stackDepth--; },\n',
     '        value: __nstOn ? __nstDepthExit : function() { if (__stackDepth > 0) __stackDepth--; },\n'],
    ["    __lockGlobal('__arrspread', function(segments) {\n",
     "    __lockGlobal('__arrspread', __nstOn ? __nstArrspread : function(segments) {\n"],
];

const HELPERS = '';

module.exports = { LABEL, EDITS, HELPERS };
