// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { buildEmitAPI } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const { effectiveCeiling } = require('../../src/gas.js');
const EmissionCollector = require('../../src/collector.js');
const ActionValidator = require('../../src/validator.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createEmitAPI(callContext, ceiling) {
    const gasTracker = new GasTracker(SCHEDULE, ceiling || 1000000);
    const collector = new EmissionCollector(50);
    const emit = buildEmitAPI(gasTracker, collector, SCHEDULE, callContext);
    return { emit, gasTracker, collector };
}

const GOOD = { contractIndex: 42, method: 'onPayment', params: ['a', 'b'], gasLimit: 50000 };

describe('emit.execute (cross-contract call)', function() {

    describe('queueing + gas reservation', function() {
        it('should queue EXECUTE with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.execute(GOOD);
            const actions = collector.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].action, 'EXECUTE');
            assert.strictEqual(actions[0].params.contractIndex, 42);
            assert.strictEqual(actions[0].params.method, 'onPayment');
            assert.deepStrictEqual(actions[0].params.params, ['a', 'b']);
            assert.strictEqual(actions[0].params.gasLimit, 50000);
        });

        it('should charge VM_EMISSION + gasLimit (the caller-funded reservation)', function() {
            const { emit, gasTracker } = createEmitAPI();
            emit.execute(GOOD);
            assert.strictEqual(gasTracker.getUsed(), SCHEDULE.VM_EMISSION + 50000);
        });

        it('should accept a numeric-string contractIndex and normalize it', function() {
            const { emit, collector } = createEmitAPI();
            emit.execute(Object.assign({}, GOOD, { contractIndex: '42' }));
            assert.strictEqual(collector.getActions()[0].params.contractIndex, 42);
        });

        it('should default params to an empty array', function() {
            const { emit, collector } = createEmitAPI();
            emit.execute({ contractIndex: 1, method: 'm', gasLimit: 5000 });
            assert.deepStrictEqual(collector.getActions()[0].params.params, []);
        });

        it('should allow gasLimit up to exactly the remaining gas', function() {
            const { emit, gasTracker } = createEmitAPI(null, 100000);
            emit.execute(Object.assign({}, GOOD, { gasLimit: 100000 - SCHEDULE.VM_EMISSION }));
            assert.strictEqual(gasTracker.getUsed(), 100000);
        });
    });

    describe('validation', function() {
        it('should fail on missing contractIndex / method / gasLimit', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.execute({ method: 'm', gasLimit: 5000 }), /contractIndex/);
            assert.throws(() => emit.execute({ contractIndex: 1, gasLimit: 5000 }), /method/);
            assert.throws(() => emit.execute({ contractIndex: 1, method: 'm' }), /gasLimit/);
        });

        it('should reject a non-positive / non-integer contractIndex', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { contractIndex: 0 })), /positive integer/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { contractIndex: -3 })), /positive integer/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { contractIndex: 1.5 })), /positive integer/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { contractIndex: 'abc' })), /positive integer/);
        });

        it('should reject a bad method (empty / oversized / wire delimiter)', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { method: '' })), /method/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { method: 'x'.repeat(65) })), /64 bytes/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { method: 'a|b' })), /must not contain/);
        });

        it('should reject bad params arrays', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { params: 'notarray' })), /array of strings/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { params: [1] })), /must be strings/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { params: ['a|b'] })), /must not contain/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { params: ['x'.repeat(1025)] })), /1024 bytes/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { params: Array(33).fill('a') })), /32 entries/);
        });

        it('should reject gasLimit below the protocol minimum', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { gasLimit: 4999 })), /\>= 5000/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { gasLimit: 5000.5 })), /\>= 5000/);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { gasLimit: '50000' })), /\>= 5000/);
        });

        it('should reject gasLimit above the remaining gas (explicit error, no charge)', function() {
            const { emit, gasTracker } = createEmitAPI(null, 30000);
            assert.throws(() => emit.execute(GOOD), /exceeds remaining gas/);
            assert.strictEqual(gasTracker.getUsed(), 0);
        });

        it('should account for the emission cost in the remaining-gas check', function() {
            // remaining = 30000; gasLimit 29800 + 500 emission > 30000 -> reject
            const { emit } = createEmitAPI(null, 30000);
            assert.throws(() => emit.execute(Object.assign({}, GOOD, { gasLimit: 29800 })), /exceeds remaining gas/);
        });
    });

    describe('depth gate', function() {
        it('should throw at max call depth before charging any gas', function() {
            const { emit, gasTracker } = createEmitAPI({ callDepth: 4, maxCallDepth: 4, minCallGas: 5000 });
            assert.throws(() => emit.execute(GOOD), /max call depth 4/);
            assert.strictEqual(gasTracker.getUsed(), 0);
        });

        it('should allow a call one hop below max depth', function() {
            const { emit, collector } = createEmitAPI({ callDepth: 3, maxCallDepth: 4, minCallGas: 5000 });
            emit.execute(GOOD);
            assert.strictEqual(collector.getActions().length, 1);
        });

        it('should default to depth 0 with protocol limits when no context is supplied', function() {
            const { emit, collector } = createEmitAPI();
            emit.execute(GOOD);
            assert.strictEqual(collector.getActions().length, 1);
        });
    });

    describe('ActionValidator', function() {
        it('should accept EXECUTE emissions', function() {
            const v = new ActionValidator();
            assert.strictEqual(v.validate({ action: 'EXECUTE', params: GOOD }), true);
        });
    });

    describe('effectiveCeiling', function() {
        it('should honor a positive integer below the config ceiling', function() {
            assert.strictEqual(effectiveCeiling(50000, 1000000), 50000);
        });
        it('should fall back to the config ceiling for invalid / oversized values', function() {
            assert.strictEqual(effectiveCeiling(undefined, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(null, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(0, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(-5, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(1.5, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling('50000', 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(2000000, 1000000), 1000000);
            assert.strictEqual(effectiveCeiling(1000000, 1000000), 1000000);
        });
    });
});
