// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping gateway tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

(XChainVM ? describe : describe.skip)('Gateway', function() {

    let vm;
    before(function() { vm = createVM(); });

    describe('context accessors', function() {
        it('should provide block height', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.getBlockHeight(); };',
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 500, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 500);
        });

        it('should provide source address', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.getSourceAddress(); };',
                state: {}, method: 'default', params: [],
                caller: 'my_address', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'my_address');
        });

        it('should provide contract address', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.getContractAddress(); };',
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:DOGE:42',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'C:DOGE:42');
        });

        it('should provide input params', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.getInputParams(); };',
                state: {}, method: 'default', params: ['arg1', 'arg2'],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.deepStrictEqual(JSON.parse(result.returnValue), ['arg1', 'arg2']);
        });

        it('should provide single param by index', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.getInputParam(1); };',
                state: {}, method: 'default', params: ['a', 'b', 'c'],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'b');
        });
    });

    describe('state operations', function() {
        it('should read/write state', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.state.set('key', 'value');
                    return xchain.state.get('key');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'value');
            assert.strictEqual(result.stateChanges.length, 1);
            assert.strictEqual(result.stateChanges[0].key, 'key');
        });

        it('should read initial state', async function() {
            const result = await vm.execute({
                code: 'module.exports = function(xchain) { return xchain.state.get("existing"); };',
                state: { existing: 'hello' }, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'hello');
        });

        it('should delete state', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    var existed = xchain.state.delete('key');
                    return existed;
                };`,
                state: { key: 'val' }, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), true);
            assert.strictEqual(result.stateDeletes.length, 1);
            assert.strictEqual(result.stateDeletes[0], 'key');
        });

        it('should check state.has', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    return { has: xchain.state.has('x'), hasNot: xchain.state.has('y') };
                };`,
                state: { x: '1' }, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            const val = JSON.parse(result.returnValue);
            assert.strictEqual(val.has, true);
            assert.strictEqual(val.hasNot, false);
        });
    });

    describe('emit', function() {
        it('should queue SEND emission', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.emit.send({ destination: 'addr2', tick: 'TEST', quantity: '100' });
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.emittedActions.length, 1);
            assert.strictEqual(result.emittedActions[0].action, 'SEND');
            assert.strictEqual(result.emittedActions[0].params.destination, 'addr2');
        });

        it('should fail on missing required params', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.emit.send({ tick: 'TEST', quantity: '100' });
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('destination'), 'error should mention missing field');
        });
    });

    describe('math', function() {
        it('should perform math operations', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    return xchain.math.add('100', '200');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), '300');
        });
    });

    describe('control flow', function() {
        it('should handle xchain.revert()', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.revert('not enough tokens');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('revert: not enough tokens'));
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should handle xchain.require() failure', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.require(false, 'condition failed');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('revert: condition failed'));
        });

        it('should pass xchain.require() on true', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.require(true, 'should not fire');
                    return 'passed';
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'passed');
        });
    });

    describe('logging', function() {
        it('should collect logs', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.log('hello', 'world');
                    xchain.log('count:', 42);
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.logs.length, 2);
            assert.strictEqual(result.logs[0], 'hello world');
            assert.strictEqual(result.logs[1], 'count: 42');
        });

        it('should preserve logs on failure', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    xchain.log('before revert');
                    xchain.revert('fail');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.logs.length, 1);
            assert.strictEqual(result.logs[0], 'before revert');
        });
    });

    describe('method routing', function() {
        it('should call named method on object export', async function() {
            const result = await vm.execute({
                code: `module.exports = {
                    greet: function(xchain) { return 'hello ' + xchain.getSourceAddress(); }
                };`,
                state: {}, method: 'greet', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'hello addr1');
        });

        it('should fail on unknown method', async function() {
            const result = await vm.execute({
                code: `module.exports = {
                    foo: function(xchain) { return 1; }
                };`,
                state: {}, method: 'bar', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('unknown method'));
        });
    });

    describe('oracle stub', function() {
        it('should return null for oracle price', async function() {
            const result = await vm.execute({
                code: `module.exports = function(xchain) {
                    return xchain.oracle.getPrice('BTC/USD');
                };`,
                state: {}, method: 'default', params: [],
                caller: 'addr1', contractAddress: 'C:BTC:1',
                blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.returnValue, 'null');
        });
    });
});
