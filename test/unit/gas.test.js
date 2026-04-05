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
});
