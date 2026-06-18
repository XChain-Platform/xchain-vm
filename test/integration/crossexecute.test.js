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
//
// In-isolate behavior of cross-chain calls: emit.crossExecute from contract
// code, getCrossHops(), crossChain.getCallResult(), and the crossCallable
// allowlist gate enforced by the contract wrapper on injected executions.

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping crossExecute integration tests: isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        execution: 'in-process',
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

const BASE = {
    state: {}, method: 'default', params: [],
    caller: 'addr1', contractAddress: 'C:BTC:1', contractIndex: 1,
    txHash: 'f'.repeat(64), actionIndex: 777, network: 'regtest',
    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
};

(XChainVM ? describe : describe.skip)('emit.crossExecute in-isolate', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('emits an XCALL action, charges the full pre-pay, and returns the call_id to the contract', async function() {
        const code = `
            module.exports = function(xchain) {
                var id = xchain.emit.crossExecute({
                    targetChain: 'DOGE', contractIndex: 99, method: 'onArrival',
                    params: ['x'], gasLimit: 50000,
                    callbackMethod: 'onResult', callbackParams: ['c1'], deadlineBlocks: 200
                });
                return id;
            };
        `;
        const r = await vm.execute(Object.assign({}, BASE, { code }));
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.emittedActions.length, 1);
        assert.strictEqual(r.emittedActions[0].action, 'XCALL');
        const id = JSON.parse(r.returnValue);
        assert.match(id, /^[0-9a-f]{64}$/);
        assert.strictEqual(r.emittedActions[0].params.callId, id);
        // 500 + 2000 + 50000 + 20000 plus metering points (incl. allocation
        // metering on the literals crossing the boundary)
        assert.ok(r.gasUsed >= 72500 && r.gasUsed < 73500, 'gasUsed ' + r.gasUsed);
    });

    it('throws deterministically on the contract\'s own chain as target', async function() {
        const code = `
            module.exports = function(xchain) {
                try {
                    xchain.emit.crossExecute({
                        targetChain: 'BTC', contractIndex: 99, method: 'm',
                        gasLimit: 50000, callbackMethod: 'cb'
                    });
                } catch (e) { return 'caught:' + e.message; }
                return 'no-throw';
            };
        `;
        const r = await vm.execute(Object.assign({}, BASE, { code }));
        assert.strictEqual(r.success, true, r.error);
        assert.match(JSON.parse(r.returnValue), /^caught:.*must differ/);
        assert.strictEqual(r.emittedActions.length, 0);
    });

    it('getCrossHops() reports the host-threaded hop count and gates further calls', async function() {
        const code = `
            module.exports = function(xchain) {
                var hops = xchain.getCrossHops();
                var gated = 'no';
                try {
                    xchain.emit.crossExecute({
                        targetChain: 'DOGE', contractIndex: 99, method: 'm',
                        gasLimit: 50000, callbackMethod: 'cb'
                    });
                } catch (e) { gated = 'yes'; }
                return hops + ':' + gated;
            };
        `;
        const atCap = await vm.execute(Object.assign({}, BASE, { code, crossHops: 2 }));
        assert.strictEqual(JSON.parse(atCap.returnValue), '2:yes');
        const underCap = await vm.execute(Object.assign({}, BASE, { code, crossHops: 1 }));
        assert.strictEqual(JSON.parse(underCap.returnValue), '1:no');
    });

    it('crossChain.getCallResult reads the snapshot', async function() {
        const code = `
            module.exports = function(xchain) {
                var done = xchain.crossChain.getCallResult('${'a'.repeat(64)}');
                var pending = xchain.crossChain.getCallResult('${'b'.repeat(64)}');
                return JSON.stringify([done, pending]);
            };
        `;
        const r = await vm.execute(Object.assign({}, BASE, {
            code,
            crossChainData: { attestations: {}, settled: {}, calls: { ['a'.repeat(64)]: { status: 'ok', payload: '"7"' } } }
        }));
        const [done, pending] = JSON.parse(JSON.parse(r.returnValue));
        assert.deepStrictEqual(done, { status: 'ok', payload: '"7"' });
        assert.strictEqual(pending, null);
    });

    describe('crossCallable allowlist gate (injected executions)', function() {
        const TARGET = `
            module.exports = {
                crossCallable: ['open'],
                open:   function(xchain) { return 'opened'; },
                closed: function(xchain) { return 'leaked'; }
            };
        `;

        it('allows an allowlisted method when isCrossCall is set', async function() {
            const r = await vm.execute(Object.assign({}, BASE, { code: TARGET, method: 'open', isCrossCall: true }));
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(JSON.parse(r.returnValue), 'opened');
        });

        it('rejects a non-allowlisted method with the fixed XCALL_NOT_CALLABLE marker', async function() {
            const r = await vm.execute(Object.assign({}, BASE, { code: TARGET, method: 'closed', isCrossCall: true }));
            assert.strictEqual(r.success, false);
            assert.match(r.error, /XCALL_NOT_CALLABLE/);
            assert.strictEqual(r.stateChanges.length, 0);
        });

        it('rejects contracts with no crossCallable export (incl. function exports)', async function() {
            const noList = `module.exports = { closed: function(xchain) { return 'x'; } };`;
            const r1 = await vm.execute(Object.assign({}, BASE, { code: noList, method: 'closed', isCrossCall: true }));
            assert.match(r1.error, /XCALL_NOT_CALLABLE/);
            const fnExport = `module.exports = function(xchain) { return 'x'; };`;
            const r2 = await vm.execute(Object.assign({}, BASE, { code: fnExport, method: 'default', isCrossCall: true }));
            assert.match(r2.error, /XCALL_NOT_CALLABLE/);
        });

        it('does NOT gate ordinary (same-chain) executions', async function() {
            const r = await vm.execute(Object.assign({}, BASE, { code: TARGET, method: 'closed' }));
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(JSON.parse(r.returnValue), 'leaked');
        });
    });
});
