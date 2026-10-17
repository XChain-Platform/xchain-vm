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

const { HARNESS_SOURCE } = require('../runtime/harness_source.js');
const { deriveHarness } = require('./derivation.js');

const EDITS = [
    [
        '        var c = +count; if (c > 0) __allocGas(c * this.length); return __repeat.apply(this, arguments);',
        '        var c = +count; if (c > 0) __allocGas(c * __String(this).length); return __repeat.apply(this, arguments);',
    ],
    [
        '    var __meterLen = function(obj, name) {\n' +
        '        var orig = obj[name];\n        if (typeof orig !== \'function\') return;\n' +
        '        __lockMethod(obj, name, function() {\n            __allocGas(this == null ? 0 : this.length);',
        '    var __meterLen = function(obj, name) {\n' +
        '        var orig = obj[name]; var stringReceiver = obj === String.prototype;\n' +
        '        if (typeof orig !== \'function\') return;\n' +
        '        __lockMethod(obj, name, function() {\n            __allocGas(stringReceiver ? __String(this).length : (this == null ? 0 : this.length));',
    ],
    [
        '    var __mreplace = function(name) {\n        var orig = String.prototype[name];\n' +
        "        if (typeof orig !== 'function') return;\n        __lockMethod(String.prototype, name, function() {\n" +
        '            var n = (this == null ? 0 : this.length);\n            if (__meterUpgradeOn) {',
        '    var __mreplace = function(name) {\n        var orig = String.prototype[name];\n' +
        "        if (typeof orig !== 'function') return;\n        __lockMethod(String.prototype, name, function() {\n" +
        '            var n = __String(this).length;\n            if (__meterUpgradeOn) {',
    ],
    [
        "    var __sconcat = String.prototype.concat;\n    if (typeof __sconcat === 'function') __lockMethod(String.prototype, 'concat', function() {\n" +
        '        var n = (this == null ? 0 : this.length);',
        "    var __sconcat = String.prototype.concat;\n    if (typeof __sconcat === 'function') __lockMethod(String.prototype, 'concat', function() {\n" +
        '        var n = __String(this).length;',
    ],
    [
        "     'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].forEach(function(m) { __meterLen(String.prototype, m); });",
        "     'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].forEach(function(m) { __meterLen(String.prototype, m); }); " +
        "__lockMethod(String.prototype, 'trimLeft', String.prototype.trimStart); " +
        "__lockMethod(String.prototype, 'trimRight', String.prototype.trimEnd); " +
        "__lockMethod(Number, 'parseInt', globalThis.parseInt || Number.parseInt); " +
        "__lockMethod(Number, 'parseFloat', globalThis.parseFloat || Number.parseFloat);",
    ],
];

const HELPERS = '';
const LABEL = 'string receiver meter';

function buildStringReceiverMeterHarness(source) {
    return deriveHarness(source, [{ label: LABEL, edits: EDITS, helpers: HELPERS }]);
}

const HARNESS_SOURCE_STRING_RECEIVER_METER = buildStringReceiverMeterHarness(HARNESS_SOURCE);

module.exports = {
    LABEL, EDITS, HELPERS,
    HARNESS_SOURCE_STRING_RECEIVER_METER, buildStringReceiverMeterHarness,
};
