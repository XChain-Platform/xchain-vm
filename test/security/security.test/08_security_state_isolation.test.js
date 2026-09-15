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
 * Security Audit Tests
 *
 * Tests for all vulnerabilities identified in the security audit:
 *   - Sandbox escape vectors (RISK-01 through RISK-03)
 *   - Error type spoofing (RISK-04)
 *   - Gas metering bypass (RISK-05, RISK-06)
 *   - Emit parameter injection / prototype pollution (RISK-10, RISK-11)
 *   - Math input abuse (RISK-12)
 *   - Information leakage (RISK-15)
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping security tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling || 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs || 5000,
            maxMemory: overrides?.maxMemory || 8,
            maxEmissions: overrides?.maxEmissions || 50,
            maxStateKeys: overrides?.maxStateKeys || 10000,
            maxStateValueSize: overrides?.maxStateValueSize || 65536,
            maxStateKeySize: overrides?.maxStateKeySize || 1024,
            maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: opts?.caller || 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: opts?.balances || {},
        tokenInfo: opts?.tokenInfo || {}
    });
}

// STATE ISOLATION (RISK-13)

(XChainVM ? describe : describe.skip)('Security: State Isolation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-13a: sequential executions should not share state', async function() {
        const r1 = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.state.set('leaked', 'secret');
                return 'written';
            };
        `);
        assert.strictEqual(r1.success, true);

        // Second execution should not see the state (different contract, no state passed)
        const r2 = await executeCode(vm, `
            module.exports = function(xchain) {
                return xchain.state.get('leaked');
            };
        `);
        assert.strictEqual(r2.success, true);
        assert.strictEqual(r2.returnValue, 'null');
    });

    it('RISK-13b: compilation cache should not leak between contracts', async function() {
        vm.beginBlock();
        try {
            const r1 = await executeCode(vm, `
                module.exports = function(xchain) { return 'contract_a'; };
            `, { contractAddress: 'C:BTC:A' });
            assert.strictEqual(r1.success, true);

            const r2 = await executeCode(vm, `
                module.exports = function(xchain) { return 'contract_b'; };
            `, { contractAddress: 'C:BTC:B' });
            assert.strictEqual(r2.success, true);

            // Results should differ
            assert.strictEqual(JSON.parse(r1.returnValue), 'contract_a');
            assert.strictEqual(JSON.parse(r2.returnValue), 'contract_b');
        } finally {
            vm.endBlock();
        }
    });
});

(XChainVM ? describe : describe.skip)('Security: State Isolation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-13c: failed execution should not persist state changes', async function() {
        const r = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.state.set('key1', 'value1');
                xchain.state.set('key2', 'value2');
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: '100' });
                xchain.revert('rollback');
            };
        `);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.stateChanges.length, 0, 'no state changes on revert');
        assert.strictEqual(r.stateDeletes.length, 0, 'no state deletes on revert');
        assert.strictEqual(r.emittedActions.length, 0, 'no emissions on revert');
    });
});
