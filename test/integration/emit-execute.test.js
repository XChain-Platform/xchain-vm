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
// In-isolate behavior of cross-contract calls: emit.execute from contract
// code, getCallDepth(), the per-call gas ceiling (caller-funded reservation),
// and the deterministic clamps against that ceiling.

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping emit-execute integration tests: isolated-vm not available:', e);
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
    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
};

(XChainVM ? describe : describe.skip)('emit.execute in-isolate', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should emit an EXECUTE action and charge the reservation', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            code: `module.exports = function(xchain) {
                xchain.emit.execute({ contractIndex: 7, method: 'ping', params: ['x'], gasLimit: 20000 });
                return 'ok';
            };`
        }));
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 1);
        assert.strictEqual(result.emittedActions[0].action, 'EXECUTE');
        assert.strictEqual(result.emittedActions[0].params.contractIndex, 7);
        assert.strictEqual(result.emittedActions[0].params.method, 'ping');
        assert.deepStrictEqual(result.emittedActions[0].params.params, ['x']);
        assert.strictEqual(result.emittedActions[0].params.gasLimit, 20000);
        // Reservation charged out of this run's budget
        assert.ok(result.gasUsed >= GAS_SCHEDULE.VM_EMISSION + 20000,
            'gasUsed ' + result.gasUsed + ' must include the 20000 reservation');
    });

    it('getCallDepth() should report 0 for a top-level run', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            code: `module.exports = function(xchain) { return xchain.getCallDepth(); };`
        }));
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 0);
    });

    it('getCallDepth() should report the host-supplied depth for a callee run', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            callDepth: 2,
            code: `module.exports = function(xchain) { return xchain.getCallDepth(); };`
        }));
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 2);
    });

    it('emit.execute at max depth should fail the execution deterministically', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            callDepth: 4,
            code: `module.exports = function(xchain) {
                xchain.emit.execute({ contractIndex: 7, method: 'ping', gasLimit: 20000 });
            };`
        }));
        assert.strictEqual(result.success, false);
        assert.ok(/max call depth/.test(result.error), 'got: ' + result.error);
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('a contract may catch the depth error and continue', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            callDepth: 4,
            code: `module.exports = function(xchain) {
                try { xchain.emit.execute({ contractIndex: 7, method: 'ping', gasLimit: 20000 }); }
                catch (e) { return 'caught'; }
            };`
        }));
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'caught');
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('per-call gasCeiling should bound the run and clamp gasUsed to it', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            gasCeiling: 10000,
            code: `module.exports = function(xchain) {
                var s = '';
                for (var i = 0; i < 1000000; i++) { s = xchain.math.add('1', '1'); }
                return s;
            };`
        }));
        assert.strictEqual(result.success, false);
        assert.ok(/^out_of_gas/.test(result.error), 'got: ' + result.error);
        // Clamped to the PER-CALL ceiling, never the 1M constructor ceiling
        assert.strictEqual(result.gasUsed, 10000);
    });

    it('per-call gasCeiling should not affect a run that fits within it', async function() {
        const result = await vm.execute(Object.assign({}, BASE, {
            gasCeiling: 10000,
            code: `module.exports = function(xchain) { return xchain.math.add('1', '2'); };`
        }));
        assert.strictEqual(result.success, true);
        assert.ok(result.gasUsed < 10000);
    });

    it('emit.execute gasLimit must fit the per-call ceiling (nested reservation)', async function() {
        // Callee running on a 10k reservation cannot reserve 20k for a grandchild.
        const result = await vm.execute(Object.assign({}, BASE, {
            gasCeiling: 10000, callDepth: 1,
            code: `module.exports = function(xchain) {
                xchain.emit.execute({ contractIndex: 7, method: 'ping', gasLimit: 20000 });
            };`
        }));
        assert.strictEqual(result.success, false);
        assert.ok(/exceeds remaining gas/.test(result.error), 'got: ' + result.error);
    });

    it('attestation request_id should differ across callPath (nested-run disambiguation)', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.attestation.request('http_get', 'https://example.com', 'cb', []);
        };`;
        // Two runs of the same contract in the same tx are distinguished by the
        // execution's call-path (set by the indexer per execution), NOT action_index
        // (which is injection-timing-dependent and non-deterministic across nodes).
        const optsA = Object.assign({}, BASE, { code, txHash: 'deadbeef', callPath: '0',
            providerDeadlines: { http_get: 100 } });
        const optsB = Object.assign({}, BASE, { code, txHash: 'deadbeef', callPath: '1',
            providerDeadlines: { http_get: 100 } });
        const a = await vm.execute(optsA);
        const b = await vm.execute(optsB);
        assert.strictEqual(a.success, true);
        assert.strictEqual(b.success, true);
        assert.notStrictEqual(JSON.parse(a.returnValue), JSON.parse(b.returnValue),
            'same contract + tx at different call-paths must derive different request_ids');
    });
});
