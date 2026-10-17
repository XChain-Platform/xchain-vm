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
        "            if (typeof s === 'string') __allocGas(s.length);\n" +
        '            return orig.apply(this, arguments);',
        "            if (typeof s === 'symbol') return orig.apply(this, arguments);\n" +
        "            s = typeof s === 'string' ? s : __String(s); __allocGas(s.length); arguments[0] = s; return orig.apply(this, arguments);",
    ],
];

const HELPERS = '';
const LABEL = 'tostring size meter';

function buildToStringSizeMeterHarness(source) {
    return deriveHarness(source, [{ label: LABEL, edits: EDITS, helpers: HELPERS }]);
}

const HARNESS_SOURCE_TOSTRING_SIZE_METER = buildToStringSizeMeterHarness(HARNESS_SOURCE);

module.exports = {
    LABEL, EDITS, HELPERS,
    HARNESS_SOURCE_TOSTRING_SIZE_METER, buildToStringSizeMeterHarness,
};
