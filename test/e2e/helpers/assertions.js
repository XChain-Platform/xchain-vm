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
 * E2E Assertion Helpers
 *
 * Readable assertion functions for E2E tests. All amount comparisons
 * use mathjs bignumber for precision.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { create, all } = require('mathjs');
const math = create(all, { number: 'BigNumber', precision: 64 });

/**
 * Assert a ledger balance equals an expected value.
 */
function assertBalance(ledger, address, tick, expected) {
    const actual = ledger.getBalance(address, tick) || '0';
    assert.strictEqual(
        math.equal(math.bignumber(actual), math.bignumber(String(expected))),
        true,
        `Balance mismatch for ${address}/${tick}: expected ${expected}, got ${actual}`
    );
}

/**
 * Assert a contract's custody balance.
 */
function assertContractBalance(ledger, contractAddress, tick, expected) {
    const actual = ledger.getContractBalance(contractAddress, tick) || '0';
    assert.strictEqual(
        math.equal(math.bignumber(actual), math.bignumber(String(expected))),
        true,
        `Contract balance mismatch for ${contractAddress}/${tick}: expected ${expected}, got ${actual}`
    );
}

/**
 * Assert a contract state key equals an expected value.
 */
function assertContractState(ledger, contractAddress, key, expected) {
    const actual = ledger.getContractStateKey(contractAddress, key);
    if (expected === null || expected === undefined) {
        assert.strictEqual(actual, null,
            `Expected state key "${key}" to be null, got ${JSON.stringify(actual)}`);
    } else {
        assert.deepStrictEqual(actual, expected,
            `State mismatch for ${contractAddress}/${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

/**
 * Assert a contract state key has been deleted.
 */
function assertContractStateDeleted(ledger, contractAddress, key) {
    const actual = ledger.getContractStateKey(contractAddress, key);
    assert.strictEqual(actual, null,
        `Expected state key "${key}" to be deleted, but got ${JSON.stringify(actual)}`);
}

/**
 * Assert emitted actions match expected list.
 */
function assertEmittedActions(result, expectedActions) {
    assert.strictEqual(result.emittedActions.length, expectedActions.length,
        `Expected ${expectedActions.length} emitted actions, got ${result.emittedActions.length}`);
    for (let i = 0; i < expectedActions.length; i++) {
        assert.strictEqual(result.emittedActions[i].action, expectedActions[i].action,
            `Action ${i}: expected ${expectedActions[i].action}, got ${result.emittedActions[i].action}`);
        if (expectedActions[i].params) {
            for (const key in expectedActions[i].params) {
                assert.strictEqual(
                    result.emittedActions[i].params[key],
                    expectedActions[i].params[key],
                    `Action ${i} param "${key}": expected ${expectedActions[i].params[key]}, got ${result.emittedActions[i].params[key]}`
                );
            }
        }
    }
}

/**
 * Assert gas used is within a range.
 */
function assertGasInRange(result, min, max) {
    assert(result.gasUsed >= min && result.gasUsed <= max,
        `Gas used ${result.gasUsed} not in range [${min}, ${max}]`);
}

/**
 * Assert execution succeeded.
 */
function assertSuccess(result) {
    assert.strictEqual(result.success, true,
        `Expected success but got error: ${result.error}`);
}

/**
 * Assert execution failed with revert.
 */
function assertReverted(result, messageSubstring) {
    assert.strictEqual(result.success, false, 'Expected failure but got success');
    assert(result.error && result.error.includes('revert:'),
        `Expected revert error, got: ${result.error}`);
    if (messageSubstring) {
        assert(result.error.includes(messageSubstring),
            `Expected error to contain "${messageSubstring}", got: ${result.error}`);
    }
    // Atomicity: no state changes or emissions on revert
    assert.strictEqual(result.stateChanges.length, 0, 'Expected no state changes on revert');
    assert.strictEqual(result.emittedActions.length, 0, 'Expected no emissions on revert');
}

/**
 * Assert execution failed with out of gas.
 */
function assertOutOfGas(result) {
    assert.strictEqual(result.success, false, 'Expected failure but got success');
    assert(result.error && result.error.includes('out_of_gas'),
        `Expected out_of_gas error, got: ${result.error}`);
    assert.strictEqual(result.stateChanges.length, 0, 'Expected no state changes on gas exhaustion');
    assert.strictEqual(result.emittedActions.length, 0, 'Expected no emissions on gas exhaustion');
}

/**
 * Assert execution failed with out of memory.
 */
function assertOutOfMemory(result) {
    assert.strictEqual(result.success, false, 'Expected failure but got success');
    assert(result.error && result.error.includes('out_of_memory'),
        `Expected out_of_memory error, got: ${result.error}`);
    assert.strictEqual(result.stateChanges.length, 0, 'Expected no state changes on OOM');
    assert.strictEqual(result.emittedActions.length, 0, 'Expected no emissions on OOM');
}

/**
 * Assert execution failed with timeout.
 */
function assertTimeout(result) {
    assert.strictEqual(result.success, false, 'Expected failure but got success');
    assert(result.error && result.error.includes('timeout'),
        `Expected timeout error, got: ${result.error}`);
}

/**
 * Assert execution failed (any error).
 */
function assertFailed(result, messageSubstring) {
    assert.strictEqual(result.success, false, 'Expected failure but got success');
    if (messageSubstring) {
        assert(result.error && result.error.includes(messageSubstring),
            `Expected error to contain "${messageSubstring}", got: ${result.error}`);
    }
}

/**
 * Assert logs contain a substring.
 */
function assertLogsContain(result, substring) {
    const found = result.logs.some(l => l.includes(substring));
    assert(found, `Expected logs to contain "${substring}", got: ${JSON.stringify(result.logs)}`);
}

/**
 * Assert return value equals expected (JSON comparison).
 */
function assertReturnValue(result, expected) {
    assert.strictEqual(result.success, true, `Expected success but got: ${result.error}`);
    if (expected === null || expected === undefined) {
        assert.strictEqual(result.returnValue, null);
    } else {
        assert.deepStrictEqual(JSON.parse(result.returnValue), expected);
    }
}

module.exports = {
    assertBalance,
    assertContractBalance,
    assertContractState,
    assertContractStateDeleted,
    assertEmittedActions,
    assertGasInRange,
    assertSuccess,
    assertReverted,
    assertOutOfGas,
    assertOutOfMemory,
    assertTimeout,
    assertFailed,
    assertLogsContain,
    assertReturnValue
};
