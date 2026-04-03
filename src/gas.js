/*********************************************************************
 * XChain VM — Gas Tracking
 *
 * Tracks gas consumption during contract execution.
 * Throws GasExhaustedError when the ceiling is exceeded.
 ********************************************************************/

const { GasExhaustedError } = require('./errors.js');

class GasTracker {
    constructor(gasSchedule, gasCeiling) {
        this.schedule = gasSchedule;
        this.ceiling  = gasCeiling;
        this.used     = 0;
    }

    charge(amount) {
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
