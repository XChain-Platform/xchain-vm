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
const crypto = require('crypto');
const { buildEmitAPI } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const EmissionCollector = require('../../src/collector.js');
const ActionValidator = require('../../src/validator.js');
const { buildCrossChainAccessor } = require('../../src/readonly-accessors.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Derivation context mirroring what gateway.js threads from readOnlyData.
const CTX = {
    callDepth: 0, maxCallDepth: 4, minCallGas: 5000,
    crossHops: 0,
    network: 'regtest',
    contractAddress: 'C:BTC:42',
    txHash: 'f'.repeat(64),
    callPath: '',          // root on-chain execution (no nested ancestry)
    contractIndex: 42
};

function createEmitAPI(ctxOverrides, ceiling) {
    const gasTracker = new GasTracker(SCHEDULE, ceiling || 1000000);
    const collector = new EmissionCollector(50);
    const emit = buildEmitAPI(gasTracker, collector, SCHEDULE, Object.assign({}, CTX, ctxOverrides));
    return { emit, gasTracker, collector };
}

const GOOD = {
    targetChain: 'DOGE', contractIndex: 99, method: 'onArrival',
    params: ['a', 'b'], gasLimit: 50000,
    callbackMethod: 'onResult', callbackParams: ['ctx'], deadlineBlocks: 200
};

describe('emit.crossExecute (cross-chain contract call)', function() {

    describe('queueing + gas charge', function() {
        it('queues XCALL with valid params and returns the call_id', function() {
            const { emit, collector } = createEmitAPI();
            const callId = emit.crossExecute(GOOD);
            assert.match(callId, /^[0-9a-f]{64}$/);
            const actions = collector.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].action, 'XCALL');
            assert.strictEqual(actions[0].params.callId, callId);
            assert.strictEqual(actions[0].params.targetChain, 'DOGE');
            assert.strictEqual(actions[0].params.contractIndex, 99);
            assert.strictEqual(actions[0].params.method, 'onArrival');
            assert.deepStrictEqual(actions[0].params.params, ['a', 'b']);
            assert.strictEqual(actions[0].params.gasLimit, 50000);
            assert.strictEqual(actions[0].params.callbackMethod, 'onResult');
            assert.deepStrictEqual(actions[0].params.callbackParams, ['ctx']);
            assert.strictEqual(actions[0].params.deadlineBlocks, 200);
            // crossHops is deliberately NOT in the emission — host-derived in the indexer.
            assert.strictEqual(actions[0].params.crossHops, undefined);
        });

        it('charges VM_EMISSION + VM_XCALL_REQUEST + gasLimit + VM_XCALL_CALLBACK, no more', function() {
            const { emit, gasTracker } = createEmitAPI();
            emit.crossExecute(GOOD);
            assert.strictEqual(gasTracker.getUsed(),
                SCHEDULE.VM_EMISSION + SCHEDULE.VM_XCALL_REQUEST + 50000 + SCHEDULE.VM_XCALL_CALLBACK);
        });

        it('throws when the total charge exceeds remaining gas (before charging anything)', function() {
            const { emit, gasTracker } = createEmitAPI({}, 60000); // < 500+2000+50000+20000
            assert.throws(() => emit.crossExecute(GOOD), /exceeds remaining gas/);
            assert.strictEqual(gasTracker.getUsed(), 0);
        });

        it('XCALL is an allowed emission action (validator)', function() {
            const v = new ActionValidator();
            assert.doesNotThrow(() => v.validate({ action: 'XCALL', params: {} }));
        });
    });

    describe('call_id derivation (consensus-critical)', function() {
        it('byte-matches sha256(network:chain:txHash:rootActionIndex:contractIndex:callPath:emissionIndex:targetChain)', function() {
            const { emit } = createEmitAPI();
            const callId = emit.crossExecute(GOOD);
            // The call-path replaces action_index: action_index depended on injection
            // timing (non-deterministic across nodes), while the call-path is content-
            // derived AND disambiguates two nested runs of the same contract. Root
            // execution → empty path segment. rootActionIndex absent → ''.
            const preimage = 'regtest:BTC:' + 'f'.repeat(64) + '::42::0:DOGE';
            assert.strictEqual(callId, crypto.createHash('sha256').update(preimage).digest('hex'));
        });

        it('reflects the emission index, so two calls in one run derive distinct ids', function() {
            const { emit } = createEmitAPI();
            const id0 = emit.crossExecute(GOOD);
            const id1 = emit.crossExecute(Object.assign({}, GOOD, { targetChain: 'LTC' }));
            assert.notStrictEqual(id0, id1);
            const pre1 = 'regtest:BTC:' + 'f'.repeat(64) + '::42::1:LTC';
            assert.strictEqual(id1, crypto.createHash('sha256').update(pre1).digest('hex'));
        });

        it('binds the call-path: two nested runs of the same contract derive distinct ids', function() {
            // The d631c28 collision regression: emissionIndex is per-execution, so two
            // runs of the same contract each emitting their FIRST cross-call both see
            // emissionIndex 0 — only the call-path (set by the indexer per execution)
            // keeps their call_ids distinct. Same everything except callPath here.
            const a = createEmitAPI({ callPath: '0' }).emit.crossExecute(GOOD);
            const b = createEmitAPI({ callPath: '1' }).emit.crossExecute(GOOD);
            assert.notStrictEqual(a, b);
            const preA = 'regtest:BTC:' + 'f'.repeat(64) + '::42:0:0:DOGE';
            assert.strictEqual(a, crypto.createHash('sha256').update(preA).digest('hex'));
        });

        it('binds the target chain: identical calls to two chains never collide', function() {
            const a = createEmitAPI().emit.crossExecute(GOOD);
            const b = createEmitAPI().emit.crossExecute(Object.assign({}, GOOD, { targetChain: 'LTC' }));
            assert.notStrictEqual(a, b);
        });

        it('binds the network: the same call on another network derives a different id', function() {
            const a = createEmitAPI().emit.crossExecute(GOOD);
            const b = createEmitAPI({ network: 'mainnet' }).emit.crossExecute(GOOD);
            assert.notStrictEqual(a, b);
        });
    });

    describe('hop gate', function() {
        it('allows hop 1 (user-originated context) and hop 2 (injected/callback context)', function() {
            assert.doesNotThrow(() => createEmitAPI({ crossHops: 0 }).emit.crossExecute(GOOD));
            assert.doesNotThrow(() => createEmitAPI({ crossHops: 1 }).emit.crossExecute(GOOD));
        });

        it('throws at the hop cap BEFORE any gas moves', function() {
            const { emit, gasTracker } = createEmitAPI({ crossHops: 2 });
            assert.throws(() => emit.crossExecute(GOOD), /max cross-chain hops 2/);
            assert.strictEqual(gasTracker.getUsed(), 0);
        });
    });

    describe('validation matrix', function() {
        const reject = (overrides, re, ctx) => {
            const { emit, gasTracker } = createEmitAPI(ctx);
            assert.throws(() => emit.crossExecute(Object.assign({}, GOOD, overrides)), re);
            assert.strictEqual(gasTracker.getUsed(), 0, 'a rejected call must charge nothing');
        };

        it('rejects an unknown target chain', () => reject({ targetChain: 'ETH' }, /targetChain/));
        it('rejects targeting the contract\'s own chain', () => reject({ targetChain: 'BTC' }, /must differ/));
        it('rejects a non-positive contractIndex', () => reject({ contractIndex: 0 }, /contractIndex/));
        it('rejects an empty method', () => reject({ method: '' }, /method/));
        it('rejects a method containing "|"', () => reject({ method: 'a|b' }, /must not contain/));
        it('rejects a method over 64 bytes', () => reject({ method: 'm'.repeat(65) }, /max 64 bytes/));
        it('rejects non-array params', () => reject({ params: 'x' }, /params/));
        it('rejects more than 32 params', () => reject({ params: Array(33).fill('x') }, /32/));
        it('rejects a param over 1024 bytes', () => reject({ params: ['p'.repeat(1025)] }, /1024/));
        it('rejects a param containing "|"', () => reject({ params: ['a|b'] }, /must not contain/));
        it('rejects a missing callbackMethod', () => reject({ callbackMethod: undefined }, /callbackMethod/));
        it('rejects oversized callbackParams JSON', () => reject({ callbackParams: ['p'.repeat(1025)] }, /callbackParams JSON/));
        it('rejects gasLimit below XCALL_MIN_GAS', () => reject({ gasLimit: 4999 }, /gasLimit/));
        it('rejects gasLimit above XCALL_MAX_GAS', () => reject({ gasLimit: 200001 }, /gasLimit/));
        it('rejects a non-integer gasLimit', () => reject({ gasLimit: 50000.5 }, /gasLimit/));
        it('rejects deadlineBlocks below 10', () => reject({ deadlineBlocks: 9 }, /deadlineBlocks/));
        it('rejects deadlineBlocks above 4000', () => reject({ deadlineBlocks: 4001 }, /deadlineBlocks/));

        it('defaults deadlineBlocks to 400 when omitted', function() {
            const { emit, collector } = createEmitAPI();
            emit.crossExecute(Object.assign({}, GOOD, { deadlineBlocks: undefined }));
            assert.strictEqual(collector.getActions()[0].params.deadlineBlocks, 400);
        });

        it('string-coerces callbackParams entries', function() {
            const { emit, collector } = createEmitAPI();
            emit.crossExecute(Object.assign({}, GOOD, { callbackParams: [7, true] }));
            assert.deepStrictEqual(collector.getActions()[0].params.callbackParams, ['7', 'true']);
        });
    });

    describe('crossChain.getCallResult accessor (snapshot-backed)', function() {
        it('returns { status, payload } for a terminal call and null while in flight', function() {
            const acc = buildCrossChainAccessor({
                attestations: {}, settled: {},
                calls: { ['a'.repeat(64)]: { status: 'ok', payload: '"42"' } }
            });
            assert.deepStrictEqual(acc.getCallResult('a'.repeat(64)), { status: 'ok', payload: '"42"' });
            assert.deepStrictEqual(acc.getCallResult('A'.repeat(64)), { status: 'ok', payload: '"42"' }); // case-insensitive
            assert.strictEqual(acc.getCallResult('b'.repeat(64)), null);
        });

        it('legacy snapshots without a calls map read as all-in-flight', function() {
            const acc = buildCrossChainAccessor({ attestations: {}, settled: {} });
            assert.strictEqual(acc.getCallResult('a'.repeat(64)), null);
        });
    });
});
