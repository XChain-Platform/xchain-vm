/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Gas Tracking
 *
 * Tracks gas consumption during contract execution.
 * Throws GasExhaustedError when the ceiling is exceeded.
 ********************************************************************/

const { GasExhaustedError } = require('./errors.js');

// Every gas key the VM itself charges against during execution (see gateway.js
// and gateway-emit.js). A schedule handed to the VM MUST define all of these:
// a missing key resolves to `undefined` the first time that operation is metered,
// which charge() then rejects deep inside execution. Validating membership up
// front turns that latent, execution-time failure into a deterministic
// construction-time error — so two operators whose schedules disagree on any of
// these keys fail loudly at startup instead of silently reaching divergent
// contract outcomes on the same block.
//
// Extra keys are intentionally tolerated. The VM is a generic library; its caller
// (the indexer) passes the full protocol fee schedule, which also carries keys the
// VM never charges (ISSUE, OWNERSHIP_ESCROW, AIRDROP_PER_RECIPIENT, VM_DEPLOY_*,
// VM_EXECUTE_BASE, ...). Those are charged by the caller, not here, so requiring
// an *exact* key set would reject every real schedule. The invariant we enforce is
// "no charged key is missing", not "no unknown key is present".
const CANONICAL_GAS_KEYS = Object.freeze([
    'VM_COMPUTATION',
    'VM_STATE_READ',
    'VM_STATE_WRITE',
    'VM_STATE_DELETE',
    'VM_ORACLE_READ',
    'VM_CROSSCHAIN_READ',
    'VM_ATTEST_REQUEST',
    'VM_EMISSION'
]);

class GasTracker {
    constructor(gasSchedule, gasCeiling) {
        // Validate schedule: all values must be non-negative integers
        for (const key in gasSchedule) {
            const val = gasSchedule[key];
            if (typeof val !== 'number' || !Number.isInteger(val) || val < 0)
                throw new Error('gas schedule value for ' + key + ' must be a non-negative integer, got: ' + val);
        }
        // Validate schedule: every key the VM charges against must be present, so a
        // schedule gap surfaces at construction rather than mid-execution.
        for (const key of CANONICAL_GAS_KEYS) {
            if (!(key in gasSchedule))
                throw new Error('gas schedule is missing required key: ' + key);
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
module.exports.CANONICAL_GAS_KEYS = CANONICAL_GAS_KEYS;
