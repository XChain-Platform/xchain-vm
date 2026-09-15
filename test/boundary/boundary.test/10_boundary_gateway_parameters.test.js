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

// Boundary group 12: Gateway Parameter Boundaries (GW-1 through GW-9)

(XChainVM ? describe : describe.skip)('Boundary: Gateway Parameters', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('GW-1: empty params array returns count 0', async function() {
        const code = 'module.exports = function(xchain) { return xchain.getInputParamCount(); };';
        const result = await executeCode(vm, code, { params: [] });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === '0' || result.returnValue === 0);
    });

    it('GW-2: very large params array', async function() {
        const params = Array.from({ length: 1000 }, (_, i) => 'param_' + i);
        const code = `module.exports = function(xchain) {
            return xchain.getInputParamCount();
        };`;
        const result = await executeCode(vm, code, { params });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === '1000' || result.returnValue === 1000);
    });

    it('GW-3: params with bridge control characters survive round-trip', async function() {
        const params = ['normal', '\x01prefix', '\x02prefix', '\x03prefix', 'has\x00null'];
        const code = `module.exports = function(xchain) {
            var results = [];
            for (var i = 0; i < xchain.getInputParamCount(); i++) {
                results.push(xchain.getInputParam(i));
            }
            return results;
        };`;
        const result = await executeCode(vm, code, { params });
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed[0], 'normal');
        assert.strictEqual(parsed[1], '\x01prefix');
        assert.strictEqual(parsed[2], '\x02prefix');
        assert.strictEqual(parsed[3], '\x03prefix');
        assert.strictEqual(parsed[4], 'has\x00null');
    });

    it('GW-4: missing blockContext fields do not crash', async function() {
        const code = `module.exports = function(xchain) {
            return JSON.stringify({
                h: xchain.getBlockHeight(),
                t: xchain.getBlockTimestamp(),
                hash: xchain.getBlockHash()
            });
        };`;
        const result = await executeCode(vm, code, { blockContext: {} });
        assert.strictEqual(result.success, true);
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Gateway Parameters', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('GW-5: null caller address accessible', async function() {
        const code = 'module.exports = function(xchain) { return xchain.getSourceAddress(); };';
        const result = await executeCode(vm, code, { caller: null });
        assert.strictEqual(result.success, true);
        // null returns as null through the bridge
        assert(result.returnValue === null || result.returnValue === 'null',
            'expected null, got: ' + result.returnValue);
    });

    it('GW-6: getBalance for nonexistent address returns null', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.getBalance('nonexistent', 'TOKEN');
        };`;
        const result = await executeCode(vm, code, { balances: {} });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-7: getTokenInfo for nonexistent token returns null', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.getTokenInfo('NONEXISTENT');
        };`;
        const result = await executeCode(vm, code, { tokenInfo: {} });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-8: oracle data unavailable does not crash', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.oracle.getPrice('BTC');
        };`;
        const result = await executeCode(vm, code, { oracleData: null });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-9: oracle getSnapshotAge fallback returns MAX_SAFE_INTEGER', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.oracle.getSnapshotAge();
        };`;
        const result = await executeCode(vm, code, { oracleData: null });
        assert.strictEqual(result.success, true);
        assert(
            result.returnValue === String(Number.MAX_SAFE_INTEGER) ||
            Number(result.returnValue) === Number.MAX_SAFE_INTEGER
        );
    });
});
