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
 * Harness line layout for the per-element meter.
 *
 * Contract-readable error positions depend on harness line numbers. The
 * unarmed harness must stay byte-identical to the previous release, and the
 * armed harness must keep every one of its lines at the same number, with
 * edits confined to single lines and new code only before the closing line.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const { HARNESS_SOURCE } = require('../../../src/index/runtime/harness_source.js');
const {
    EDITS, HELPERS, HARNESS_SOURCE_PER_ELEMENT_METER, buildPerElementMeterHarness,
} = require('../../../src/index/armed_harness/per_element_meter.js');

// HARNESS_SOURCE of the parent commit: line count and sha256.
const PREVIOUS_LINES = 1631;
const PREVIOUS_SHA256 = 'b6b49ddc0b95da4724b337fcf9482d9bb3f1ac0da02c6b0e8758773e6622c748';
// The 1-based lines the armed harness edits in place.
const EDITED_LINES = [1446, 1459, 1475, 1603];

describe('per-element meter: harness line layout', function () {
    const prev = HARNESS_SOURCE.split('\n');
    const armed = HARNESS_SOURCE_PER_ELEMENT_METER.split('\n');
    const closing = prev.length - 2;   // index of the closing line; the last element is ''

    it('the unarmed harness is the previous release, line for line', function () {
        assert.strictEqual(prev.length, PREVIOUS_LINES);
        assert.strictEqual(crypto.createHash('sha256').update(HARNESS_SOURCE).digest('hex'), PREVIOUS_SHA256);
        assert.strictEqual(prev[closing], '})();');
    });

    it('the armed harness keeps every previous line at its number', function () {
        const differing = [];
        for (let i = 0; i < closing; i++) if (armed[i] !== prev[i]) differing.push(i + 1);
        assert.deepStrictEqual(differing, EDITED_LINES);
        const added = HELPERS.split('\n').length - 1;
        assert.strictEqual(armed.length, prev.length + added);
        assert.deepStrictEqual(armed.slice(closing, closing + added), HELPERS.split('\n').slice(0, added));
        assert.deepStrictEqual(armed.slice(closing + added), prev.slice(closing));
    });

    it('every edit replaces text on the same lines and matches exactly once', function () {
        for (const [from, to] of EDITS) {
            assert.strictEqual(HARNESS_SOURCE.split(from).length - 1, 1, from.trim());
            assert.strictEqual(from.split('\n').length, to.split('\n').length, from.trim());
        }
        assert.throws(() => buildPerElementMeterHarness(HARNESS_SOURCE.replace(EDITS[1][0], '')),
            /matched 0 times/);
        assert.throws(() => buildPerElementMeterHarness(HARNESS_SOURCE + '\n'), /closing line/);
    });
});
