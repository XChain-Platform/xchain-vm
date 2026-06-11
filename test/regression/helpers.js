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
 * Regression Test Helpers
 *
 * Shared utilities for the regression test suite. Unlike the rest of
 * the test suite, regression tests FAIL LOUDLY if isolated-vm is
 * unavailable — silent skips are unacceptable in regression.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');

// ── Fail-loud isolated-vm check ─────────────────────────────────
// Regression tests must never silently skip. If isolated-vm is not
// compiled, the whole suite must fail with a clear message.
let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    throw new Error(
        'REGRESSION SUITE FATAL: isolated-vm is not available.\n' +
        'Regression tests must not silently skip — the VM cannot be tested.\n' +
        'Original error: ' + e.message
    );
}

// ── Standard gas schedule (mirrors platform defaults) ───────────
const GAS_SCHEDULE = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_EMISSION:        500
};

// ── Standard limits ─────────────────────────────────────────────
const DEFAULT_LIMITS = {
    maxCpuTimeMs:      5000,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxStateKeySize:   1024,
    maxCodeSize:       65536,
    maxBlockCacheSize: 1000
};

/**
 * Create a VM instance with optional overrides.
 * @param {object} [overrides] - Override gasCeiling, limits, or gasSchedule fields
 * @returns {XChainVM}
 */
function createVM(overrides) {
    return new XChainVM({
        execution: 'in-process',  // explicit: containment not needed in unit/fuzz harnesses
        gasSchedule: overrides?.gasSchedule || GAS_SCHEDULE,
        gasCeiling:  overrides?.gasCeiling  || 1000000,
        limits: { ...DEFAULT_LIMITS, ...(overrides?.limits || {}) }
    });
}

/**
 * Execute contract code in the VM.
 * @param {XChainVM} vm
 * @param {string} code - Contract source
 * @param {object} [opts] - Override execution params
 * @returns {Promise<object>} VM result
 */
function execute(vm, code, opts) {
    return vm.execute({
        code,
        state:           opts?.state           || {},
        method:          opts?.method          || 'default',
        params:          opts?.params          || [],
        caller:          opts?.caller          || 'regression_test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:REG',
        blockContext:    opts?.blockContext     || { height: 1000, timestamp: 1700000000, hash: 'regression_hash' },
        balances:        opts?.balances,
        tokenInfo:       opts?.tokenInfo,
        oracleData:      opts?.oracleData,
        crossChainData:  opts?.crossChainData,
        contractIndex:   opts?.contractIndex
    });
}

/**
 * Execute the same code N times and return all results.
 * Used for determinism verification.
 */
async function executeNTimes(vm, code, opts, n) {
    const results = [];
    for (let i = 0; i < n; i++) {
        results.push(await execute(vm, code, opts));
    }
    return results;
}

/**
 * Assert that a result has the correct 8-field shape.
 */
function assertResultShape(result) {
    assert.strictEqual(typeof result.success, 'boolean', 'success must be boolean');
    assert.strictEqual(typeof result.gasUsed, 'number', 'gasUsed must be number');
    assert(Array.isArray(result.stateChanges), 'stateChanges must be array');
    assert(Array.isArray(result.stateDeletes), 'stateDeletes must be array');
    assert(Array.isArray(result.emittedActions), 'emittedActions must be array');
    assert(Array.isArray(result.logs), 'logs must be array');
    assert('returnValue' in result, 'returnValue must be present');
    assert('error' in result, 'error must be present');
}

/**
 * Assert full atomicity on failure: no state changes, no emissions, logs preserved.
 */
function assertAtomicFailure(result) {
    assert.strictEqual(result.success, false, 'expected failure');
    assert.strictEqual(result.stateChanges.length, 0, 'state changes must be empty on failure');
    assert.strictEqual(result.emittedActions.length, 0, 'emissions must be empty on failure');
}

module.exports = {
    XChainVM,
    GAS_SCHEDULE,
    DEFAULT_LIMITS,
    createVM,
    execute,
    executeNTimes,
    assertResultShape,
    assertAtomicFailure
};
