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
 * MockLedger.normalizeToTick: pin the ROUNDING MODE, not just the width.
 *
 * The harness's whole claim to being evidence is that normalizeToTick rounds an
 * emitted amount the way the real indexer rounds it at ledger-write time. The
 * mode is half-up (away from zero), matching xchain-indexer/src/utility.js
 * bcadd/bcround and xchain-hub/src/bcmath.js, both of which pin it by test.
 *
 * A comment claiming half-even sat on this method for a while and no test
 * contradicted it, because every case anyone had written rounds the same way
 * under both modes. The cases below are chosen so the two modes DISAGREE: at a
 * midpoint whose last kept digit is EVEN, half-even keeps it and half-up lifts
 * it. That is the only shape that can catch a mode change, and a mode change
 * here would make the harness quietly bless emissions the real indexer rejects.
 *
 * No isolated-vm: MockLedger is plain mathjs, so this runs anywhere.
 ********************************************************************/
'use strict';

const assert = require('assert');
const MockLedger = require('../e2e/helpers/MockLedger.js');

describe('MockLedger.normalizeToTick rounding mode', function () {

    function ledgerWith(tick, decimals) {
        const l = new MockLedger();
        l.setTokenDecimals(tick, decimals);
        return l;
    }

    it('rounds HALF-UP, not half-even, at 8 decimals', function () {
        const l = ledgerWith('TESTA', 8);
        // Discriminating case: kept digit 2 is EVEN, so half-even would keep
        // 0.00000002 and only half-up lifts it to 0.00000003.
        assert.strictEqual(l.normalizeToTick('TESTA', '0.000000025'), '0.00000003');
        // Non-discriminating, but it is the case the review measured.
        assert.strictEqual(l.normalizeToTick('TESTA', '0.000000015'), '0.00000002');
    });

    it('rounds HALF-UP, not half-even, at 0 decimals', function () {
        const l = ledgerWith('TESTB', 0);
        assert.strictEqual(l.normalizeToTick('TESTB', '2.5'), '3', 'half-even would give 2');
        assert.strictEqual(l.normalizeToTick('TESTB', '3.5'), '4');
        assert.strictEqual(l.normalizeToTick('TESTB', '0.5'), '1', 'half-even would give 0');
    });

    it('rounds away from zero on negatives (half-up, not half-down)', function () {
        const l = ledgerWith('TESTC', 0);
        assert.strictEqual(l.normalizeToTick('TESTC', '-2.5'), '-3');
    });

    it('leaves on-grid amounts untouched', function () {
        const l = ledgerWith('TESTD', 8);
        assert.strictEqual(l.normalizeToTick('TESTD', '1.00000000'), '1.00000000');
        assert.strictEqual(l.normalizeToTick('TESTD', '0.12345678'), '0.12345678');
    });

    it('returns the amount unchanged for an unregistered tick', function () {
        const l = new MockLedger();
        assert.strictEqual(l.normalizeToTick('NOPE', '0.000000025'), '0.000000025');
    });
});
