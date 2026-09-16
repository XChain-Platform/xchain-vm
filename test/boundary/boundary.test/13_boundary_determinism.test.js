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
 * XChain VM: Boundary Test Suite
 *
 * Tests the VM at the exact edges of every configurable limit, hardcoded cap,
 * and validation threshold. Each section targets a specific boundary area
 * from the Boundary Testing Plan.
 *
 * Sections:
 *   1. Gas Ceiling Enforcement (G-1 through G-7)
 *   2. Wall-Clock Timeout (T-1 through T-4)
 *   3. Memory Limits (M-1 through M-4)
 *   4. Code Size (CS-1 through CS-6)
 *   5. State Management (S-1 through S-14)
 *   6. Emission Limits (E-1 through E-7)
 *   7. Log Limits (L-1 through L-7)
 *   8. Return Value Truncation (R-1 through R-5)
 *   9. Math Operations (MA-1 through MA-10)
 *  10. Metering & AST Injection (ME-1 through ME-7)
 *  11. Sandbox Escape Boundaries (SB-1 through SB-8)
 *  12. Gateway Parameter Boundaries (GW-1 through GW-9)
 *  13. Emit Action Field Boundaries (EA-1 through EA-8)
 *  14. Compound Interaction Boundaries
 *  15. Determinism at Boundaries
 */
// @ts-nocheck

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping VM boundary tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling !== undefined ? overrides.gasCeiling : 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs !== undefined ? overrides.maxCpuTimeMs : 5000,
            maxMemory: overrides?.maxMemory !== undefined ? overrides.maxMemory : 8,
            maxEmissions: overrides?.maxEmissions !== undefined ? overrides.maxEmissions : 50,
            maxStateKeys: overrides?.maxStateKeys !== undefined ? overrides.maxStateKeys : 10000,
            maxStateValueSize: overrides?.maxStateValueSize !== undefined ? overrides.maxStateValueSize : 65536,
            maxCodeSize: overrides?.maxCodeSize !== undefined ? overrides.maxCodeSize : 65536,
            maxStateKeySize: overrides?.maxStateKeySize !== undefined ? overrides.maxStateKeySize : 1024,
            maxBlockCacheSize: overrides?.maxBlockCacheSize !== undefined ? overrides.maxBlockCacheSize : 1000
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code:            code,
        state:           opts?.state || {},
        method:          opts?.method || 'default',
        params:          opts?.params || [],
        caller:          opts?.caller !== undefined ? opts.caller : 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext:    opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances:        opts?.balances || {},
        tokenInfo:       opts?.tokenInfo || {},
        oracleData:      opts?.oracleData || null,
        crossChainData:  opts?.crossChainData || null
    });
}

// Boundary group 15: Determinism at Boundaries

(XChainVM ? describe : describe.skip)('Boundary: Determinism', function() {

    it('identical results across 3 runs at gas boundary', async function() {
        const vm = createVM({ gasCeiling: 500 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('counter', '1');
            return xchain.math.add('100', '200');
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].returnValue, results[0].returnValue);
            assert.deepStrictEqual(results[i].stateChanges, results[0].stateChanges);
            assert.deepStrictEqual(results[i].emittedActions, results[0].emittedActions);
        }
    });

    it('identical failure results across 3 runs at emission boundary', async function() {
        const vm = createVM({ maxEmissions: 3 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 10; i++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].error, results[0].error);
        }
    });

    it('identical results across 3 runs with state at limit', async function() {
        const vm = createVM({ maxStateKeys: 3 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.state.set('c', '3');
            return xchain.state.get('a');
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].returnValue, results[0].returnValue);
            assert.deepStrictEqual(results[i].stateChanges, results[0].stateChanges);
        }
    });
});
