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
 * Fuzz Testing Invariants
 *
 * Invariant checker functions that define "correct behavior" for
 * the VM regardless of input. Each throws AssertionError on failure.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { DEFAULT_LIMITS } = require('./harness');

function checkResultShape(result) {
    assert(result !== null && result !== undefined, 'result must not be null/undefined');
    assert.strictEqual(typeof result.success, 'boolean', 'success must be boolean');
    assert.strictEqual(typeof result.gasUsed, 'number', 'gasUsed must be number');
    assert(Number.isFinite(result.gasUsed), 'gasUsed must be finite');
    assert(result.gasUsed >= 0, 'gasUsed must be non-negative');
    assert(Array.isArray(result.stateChanges), 'stateChanges must be array');
    assert(Array.isArray(result.stateDeletes), 'stateDeletes must be array');
    assert(Array.isArray(result.emittedActions), 'emittedActions must be array');
    assert(Array.isArray(result.logs), 'logs must be array');
    if (result.success) {
        assert.strictEqual(result.error, null, 'error must be null on success');
    } else {
        assert.strictEqual(typeof result.error, 'string', 'error must be string on failure');
    }
    if (result.returnValue !== null) {
        assert.strictEqual(typeof result.returnValue, 'string', 'returnValue must be string or null');
    }
}

function checkAtomicity(result) {
    if (!result.success) {
        assert.strictEqual(result.stateChanges.length, 0,
            'stateChanges must be empty on failure, got ' + result.stateChanges.length);
        assert.strictEqual(result.stateDeletes.length, 0,
            'stateDeletes must be empty on failure, got ' + result.stateDeletes.length);
        assert.strictEqual(result.emittedActions.length, 0,
            'emittedActions must be empty on failure, got ' + result.emittedActions.length);
    }
}

function checkGasCeiling(result, gasCeiling) {
    gasCeiling = gasCeiling || 1000000;
    // Allow a small buffer for the final charge that triggers exhaustion
    const maxAllowed = gasCeiling + 1000;
    assert(result.gasUsed <= maxAllowed,
        'gasUsed (' + result.gasUsed + ') exceeds ceiling (' + gasCeiling + ') by more than buffer');
}

function checkEmissionCap(result, maxEmissions) {
    maxEmissions = maxEmissions || DEFAULT_LIMITS.maxEmissions;
    assert(result.emittedActions.length <= maxEmissions,
        'emittedActions.length (' + result.emittedActions.length + ') exceeds cap (' + maxEmissions + ')');
}

function checkStateLimits(result, limits) {
    limits = limits || DEFAULT_LIMITS;
    for (const change of result.stateChanges) {
        assert(typeof change.key === 'string', 'stateChange key must be string');
        const keyBytes = Buffer.byteLength(change.key, 'utf8');
        assert(keyBytes <= (limits.maxStateKeySize || 1024),
            'stateChange key exceeds max size: ' + keyBytes);
        const valBytes = Buffer.byteLength(JSON.stringify(change.value), 'utf8');
        assert(valBytes <= limits.maxStateValueSize,
            'stateChange value exceeds max size: ' + valBytes);
    }
}

function checkNoPrototypePollution() {
    const ownKeys = Object.getOwnPropertyNames(Object.prototype);
    const expected = [
        'constructor', 'hasOwnProperty', 'isPrototypeOf',
        'propertyIsEnumerable', 'toString', 'valueOf',
        'toLocaleString', '__defineGetter__', '__defineSetter__',
        '__lookupGetter__', '__lookupSetter__', '__proto__'
    ];
    for (const key of ownKeys) {
        assert(expected.includes(key),
            'Object.prototype has unexpected property: ' + key);
    }

    const arr = [];
    arr.push(1);
    assert.strictEqual(arr.length, 1, 'Array.prototype.push is broken');

    assert.strictEqual(typeof Function.prototype.call, 'function',
        'Function.prototype.call is broken');

    assert.strictEqual(Object.prototype.toString.call({}), '[object Object]',
        'Object.prototype.toString is broken');
}

function checkDeterminism(result1, result2, hashResult) {
    const h1 = hashResult(result1);
    const h2 = hashResult(result2);
    assert.strictEqual(h1, h2,
        'Determinism violation: results differ.\n' +
        'Result 1 error: ' + result1.error + ', gasUsed: ' + result1.gasUsed + '\n' +
        'Result 2 error: ' + result2.error + ', gasUsed: ' + result2.gasUsed);
}

function checkAll(result, limits, gasCeiling) {
    checkResultShape(result);
    checkAtomicity(result);
    checkGasCeiling(result, gasCeiling);
    checkEmissionCap(result, limits?.maxEmissions);
    checkStateLimits(result, limits);
    checkNoPrototypePollution();
}

module.exports = {
    checkResultShape,
    checkAtomicity,
    checkGasCeiling,
    checkEmissionCap,
    checkStateLimits,
    checkNoPrototypePollution,
    checkDeterminism,
    checkAll
};
