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
 * XChain VM: Gas Tracking
 *
 * Tracks gas consumption during contract execution.
 * Throws GasExhaustedError when the ceiling is exceeded.
 ********************************************************************/

const { GasExhaustedError } = require('./errors.js');

// Every gas key the VM charges against during execution (gateway.js,
// gateway-emit.js). The constructor asserts each is present so a schedule gap
// fails at construction, not mid-execution where a missing key resolves to
// `undefined` and two operators with disagreeing schedules diverge on the same
// block. Extra keys are tolerated: the indexer passes the full protocol fee
// schedule, which carries keys the VM never charges. The invariant is "no
// charged key is missing", not "no unknown key present".
const CANONICAL_GAS_KEYS = Object.freeze([
    'VM_COMPUTATION',
    'VM_STATE_READ',
    'VM_STATE_WRITE',
    'VM_STATE_DELETE',
    'VM_ORACLE_READ',
    'VM_CROSSCHAIN_READ',
    'VM_ATTEST_REQUEST',
    'VM_EMISSION',
    // XCALL buckets, charged unconditionally by emit.crossExecute (gateway-emit.js).
    'VM_XCALL_REQUEST',
    'VM_XCALL_CALLBACK'
]);

// Resolve the gas ceiling for ONE execution. A cross-contract call runs the
// callee with the caller-funded reservation (opts.gasCeiling = gasLimit);
// invalid or over-ceiling requests fall back to the configured ceiling. Shared
// by the in-process path (index.js) and the subprocess host-termination clamp
// (process-executor.js) so both bill the SAME gasUsed; drift would fork.
function effectiveCeiling(requested, configCeiling) {
    if (typeof requested === 'number' && Number.isInteger(requested) &&
        requested > 0 && requested < configCeiling)
        return requested;
    return configCeiling;
}

class GasTracker {
    constructor(gasSchedule, gasCeiling) {
        // Validate schedule: all values must be non-negative integers
        for (const key in gasSchedule) {
            const val = gasSchedule[key];
            // typeof is a redundant guard: Number.isInteger never coerces, so it
            // already rejects every non-number. Kept for intent; equivalent mutant
            // (proven in test/unit/gas.test.js boundary tests).
            // Stryker disable next-line ConditionalExpression: redundant typeof guard (equivalent mutant)
            if (typeof val !== 'number' || !Number.isInteger(val) || val < 0)
                throw new Error('gas schedule value for ' + key + ' must be a non-negative integer, got: ' + val);
        }
        // Every charged key must be present (rationale at CANONICAL_GAS_KEYS above).
        for (const key of CANONICAL_GAS_KEYS) {
            if (!(key in gasSchedule))
                throw new Error('gas schedule is missing required key: ' + key);
        }
        this.schedule = gasSchedule;
        this.ceiling  = gasCeiling;
        this.used     = 0;
    }

    charge(amount) {
        // A missing GAS_SCHEDULE key resolves to undefined; `used += undefined`
        // becomes NaN and silently disables the ceiling. Reject non-finite amounts
        // so a config gap surfaces immediately instead of charging zero gas.
        // (typeof is a redundant guard kept for intent; equivalent mutant.)
        // Stryker disable next-line ConditionalExpression: redundant typeof guard (equivalent mutant)
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
module.exports.effectiveCeiling = effectiveCeiling;
