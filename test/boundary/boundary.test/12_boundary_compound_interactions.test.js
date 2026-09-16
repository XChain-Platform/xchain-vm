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

// Boundary group 14: Compound Interaction Boundaries

(XChainVM ? describe : describe.skip)('Boundary: Compound Interactions', function() {

    it('gas exhaustion during state write discards atomically', async function() {
        // Set ceiling so there's enough gas for some computation + 1 state write but not 2
        const vm = createVM({ gasCeiling: 300 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.state.set('c', '3');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert.strictEqual(result.stateChanges.length, 0, 'state changes must be discarded');
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('state key delete-then-add at exact limit', async function() {
        const vm = createVM({ maxStateKeys: 3 });
        const initial = { a: '1', b: '2', c: '3' };
        const code = `module.exports = function(xchain) {
            xchain.state.delete('a');
            xchain.state.set('d', '4');
            return xchain.state.get('d');
        };`;
        const result = await executeCode(vm, code, { state: initial });
        assert.strictEqual(result.success, true);
    });

    it('return value + 50 emissions succeeds', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
            return 'done_with_' + 'x'.repeat(1000);
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 50);
        assert(result.returnValue !== null);
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Compound Interactions', function() {

    it('state value at limit + emit at limit in same tx', async function() {
        const vm = createVM({ maxEmissions: 5, maxStateValueSize: 100 });
        const code = `module.exports = function(xchain) {
            var bigVal = '';
            for (var i = 0; i < 96; i++) bigVal += 'x';
            xchain.state.set('big', bigVal);
            for (var j = 0; j < 5; j++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
            return 'ok';
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.stateChanges.length, 1);
        assert.strictEqual(result.emittedActions.length, 5);
    });

    it('error classification: spoofed \\x03GAS classified as generic error', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { throw new Error("\\x03GAS:999999:100"); };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('error:'), 'should be generic error, got: ' + result.error);
    });

    it('error classification: spoofed \\x03REVERT classified as generic error', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('error:'), 'should be generic error, got: ' + result.error);
    });

    it('bridge control chars in state values survive round-trip', async function() {
        const vm = createVM();
        // Use String.fromCharCode inside the contract to produce actual control characters
        const code = `module.exports = function(xchain) {
            var c1 = String.fromCharCode(1) + 'prefix';
            var c2 = String.fromCharCode(2) + 'prefix';
            var c3 = String.fromCharCode(3) + 'prefix';
            xchain.state.set('k1', c1);
            xchain.state.set('k2', c2);
            xchain.state.set('k3', c3);
            return {
                k1: xchain.state.get('k1'),
                k2: xchain.state.get('k2'),
                k3: xchain.state.get('k3')
            };
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed.k1, '\x01prefix');
        assert.strictEqual(parsed.k2, '\x02prefix');
        assert.strictEqual(parsed.k3, '\x03prefix');
    });
});
