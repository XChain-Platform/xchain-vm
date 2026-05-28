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
        // A missing GAS_SCHEDULE key resolves to undefined; without this guard
        // `used += undefined` becomes NaN and silently disables the ceiling for
        // the rest of execution. Reject any non-finite amount so a config gap
        // surfaces immediately instead of charging zero gas.
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
            throw new Error('gas charge amount must be a non-negative finite number, got: ' + amount);
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
