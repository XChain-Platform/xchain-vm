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
'use strict';

const assert = require('assert');
const { HARNESS_SOURCE } = require('../../../src/index/runtime/harness_source.js');
const { deriveHarness } = require('../../../src/index/armed_harness/derivation.js');
const select = require('../../../src/index/armed_harness/select.js');
const rule = require('../../../src/index/armed_harness/tostring_size_meter.js');

describe('tostring size meter: rule source', function () {
    it('exports a standalone armed-harness rule', function () {
        assert.strictEqual(rule.LABEL, 'tostring size meter');
        assert.ok(Array.isArray(rule.EDITS));
        assert.ok(rule.EDITS.length > 0);
        assert.strictEqual(rule.HELPERS, '');
        assert.strictEqual(typeof rule.buildToStringSizeMeterHarness, 'function');
        assert.strictEqual(
            rule.HARNESS_SOURCE_TOSTRING_SIZE_METER,
            deriveHarness(HARNESS_SOURCE, [{ label: rule.LABEL, edits: rule.EDITS, helpers: rule.HELPERS }]),
        );
    });

    it('keeps harness lines fixed and converts inside __meterGlobalFn', function () {
        const armed = rule.HARNESS_SOURCE_TOSTRING_SIZE_METER;
        const start = HARNESS_SOURCE.indexOf('    var __meterGlobalFn');
        const end = HARNESS_SOURCE.indexOf('    var __globalFns');
        const armedStart = armed.indexOf('    var __meterGlobalFn');
        const armedEnd = armed.indexOf('    var __globalFns');

        assert.ok(start > 0);
        assert.ok(end > start);
        assert.strictEqual(armedStart, start);
        assert.ok(armed.slice(armedStart, armedEnd).includes('__String('));
        assert.strictEqual(armed.slice(armedEnd), HARNESS_SOURCE.slice(end));
        assert.strictEqual(armed.split('\n').length, HARNESS_SOURCE.split('\n').length);
    });

    it('derives beside every rule select.js currently lists in RULES', function () {
        const selected = select.RULES
            .filter((selectedRule) => selectedRule.LABEL !== rule.LABEL)
            .map((selectedRule) => ({
                label: selectedRule.LABEL,
                edits: selectedRule.EDITS,
                helpers: selectedRule.HELPERS,
            }));
        const combined = deriveHarness(HARNESS_SOURCE, selected.concat([{
            label: rule.LABEL,
            edits: rule.EDITS,
            helpers: rule.HELPERS,
        }]));

        assert.strictEqual(typeof combined, 'string');
    });
});
