/*********************************************************************
 * XChain VM — Gas Tracking
 *
 * Tracks gas consumption during contract execution.
 * Throws GasExhaustedError when the ceiling is exceeded.
 ********************************************************************/

const { GasExhaustedError } = require('./errors.js');

class GasTracker {
    constructor(gasSchedule, gasCeiling) {
        // Validate schedule: all values must be non-negative integers
        for (const key in gasSchedule) {
            const val = gasSchedule[key];
            if (typeof val !== 'number' || !Number.isInteger(val) || val < 0)
                throw new Error('gas schedule value for ' + key + ' must be a non-negative integer, got: ' + val);
        }
        this.schedule = gasSchedule;
        this.ceiling  = gasCeiling;
        this.used     = 0;
    }

    charge(amount) {
        if (amount < 0)
            throw new Error('gas charge amount must be non-negative, got: ' + amount);
        this.used += amount;
        if (this.used > this.ceiling)
            throw new GasExhaustedError(this.used, this.ceiling);
    }

    chargeComputation() {
        this.charge(this.schedule.VM_COMPUTATION);
    }

    getUsed() {
        return this.used;
    }
}

module.exports = GasTracker;
