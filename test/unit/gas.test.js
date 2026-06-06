// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const GasTracker = require('../../src/gas.js');
const { GasExhaustedError } = require('../../src/errors.js');

describe('GasTracker', function() {

    const SCHEDULE = {
        VM_COMPUTATION:    1,
        VM_STATE_READ:     100,
        VM_STATE_WRITE:    200,
        VM_STATE_DELETE:   100,
        VM_ORACLE_READ:    100,
        VM_CROSSCHAIN_READ: 100,
        VM_ATTEST_REQUEST: 5000,
        VM_EMISSION:       500
    };

    it('should start with 0 gas used', function() {
        const tracker = new GasTracker(SCHEDULE, 1000);
        assert.strictEqual(tracker.getUsed(), 0);
    });

    it('should track gas charges', function() {
        const tracker = new GasTracker(SCHEDULE, 1000);
        tracker.charge(100);
        assert.strictEqual(tracker.getUsed(), 100);
        tracker.charge(200);
        assert.strictEqual(tracker.getUsed(), 300);
    });

    it('should allow charge exactly at ceiling', function() {
        const tracker = new GasTracker(SCHEDULE, 100);
        // Should not throw — used == ceiling is OK
        tracker.charge(100);
        assert.strictEqual(tracker.getUsed(), 100);
    });

    it('should throw GasExhaustedError when ceiling exceeded', function() {
        const tracker = new GasTracker(SCHEDULE, 100);
        assert.throws(() => {
            tracker.charge(101);
        }, GasExhaustedError);
    });

    it('should throw GasExhaustedError with correct values', function() {
        const tracker = new GasTracker(SCHEDULE, 100);
        tracker.charge(50);
        try {
            tracker.charge(51);
            assert.fail('should have thrown');
        } catch (e) {
            assert(e instanceof GasExhaustedError);
            assert.strictEqual(e.used, 101);
            assert.strictEqual(e.ceiling, 100);
        }
    });

    it('should charge computation gas', function() {
        const tracker = new GasTracker(SCHEDULE, 1000);
        tracker.chargeComputation();
        assert.strictEqual(tracker.getUsed(), SCHEDULE.VM_COMPUTATION);
    });

    it('should handle cumulative computation charges', function() {
        const tracker = new GasTracker(SCHEDULE, 10);
        for (let i = 0; i < 10; i++) {
            tracker.chargeComputation();
        }
        assert.strictEqual(tracker.getUsed(), 10);
        // 11th should throw
        assert.throws(() => {
            tracker.chargeComputation();
        }, GasExhaustedError);
    });

    it('should handle zero gas charge', function() {
        const tracker = new GasTracker(SCHEDULE, 100);
        tracker.charge(0);
        assert.strictEqual(tracker.getUsed(), 0);
    });

    it('should exhaust immediately with ceiling of 0', function() {
        const tracker = new GasTracker(SCHEDULE, 0);
        assert.throws(() => tracker.charge(1), GasExhaustedError);
    });

    it('should not throw for charge(0) with ceiling 0', function() {
        const tracker = new GasTracker(SCHEDULE, 0);
        tracker.charge(0);
        assert.strictEqual(tracker.getUsed(), 0);
    });

    it('should accumulate large charges', function() {
        const tracker = new GasTracker(SCHEDULE, 1000000);
        tracker.charge(500000);
        tracker.charge(500000);
        assert.strictEqual(tracker.getUsed(), 1000000);
    });

    it('should reject negative gas charge', function() {
        const tracker = new GasTracker(SCHEDULE, 1000);
        assert.throws(() => tracker.charge(-1), /non-negative/);
    });

    it('should reject negative schedule value in constructor', function() {
        assert.throws(() => new GasTracker({ ...SCHEDULE, VM_COMPUTATION: -1 }, 1000), /non-negative integer/);
    });

    it('should reject float schedule value in constructor', function() {
        assert.throws(() => new GasTracker({ ...SCHEDULE, VM_COMPUTATION: 1.5 }, 1000), /non-negative integer/);
    });

    it('should reject non-number schedule value in constructor', function() {
        assert.throws(() => new GasTracker({ ...SCHEDULE, VM_COMPUTATION: 'fast' }, 1000), /non-negative integer/);
    });

    // Canonical key-set enforcement: a schedule that omits a key the VM charges
    // against would otherwise pass validation and only fail mid-execution (or, on
    // a divergent operator, silently produce a different gasUsed). Construction
    // must reject any missing canonical key.
    it('should reject a schedule missing a canonical key in constructor', function() {
        const incomplete = { ...SCHEDULE };
        delete incomplete.VM_ATTEST_REQUEST;
        assert.throws(() => new GasTracker(incomplete, 1000), /missing required key: VM_ATTEST_REQUEST/);
    });

    it('should reject a schedule missing any canonical key in constructor', function() {
        for (const key of GasTracker.CANONICAL_GAS_KEYS) {
            const incomplete = { ...SCHEDULE };
            delete incomplete[key];
            assert.throws(
                () => new GasTracker(incomplete, 1000),
                new RegExp('missing required key: ' + key),
                'expected construction to throw when ' + key + ' is absent'
            );
        }
    });

    // Extra keys are tolerated by design: the VM receives the full protocol fee
    // schedule from the indexer, which carries keys the VM never charges.
    it('should accept a schedule carrying extra (non-charged) keys', function() {
        const withExtras = {
            ...SCHEDULE,
            ISSUE:              100000,
            OWNERSHIP_ESCROW:   50000,
            VM_DEPLOY_BASE:     100000,
            VM_DEPLOY_PER_BYTE: 10,
            VM_EXECUTE_BASE:    1000
        };
        const tracker = new GasTracker(withExtras, 1000);
        assert.strictEqual(tracker.getUsed(), 0);
    });

    it('should accept the complete canonical schedule', function() {
        const tracker = new GasTracker(SCHEDULE, 1000);
        assert.strictEqual(tracker.getUsed(), 0);
    });
});
