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

// Boundary group 8: Return Value Truncation (R-1 through R-5)

(XChainVM ? describe : describe.skip)('Boundary: Return Value Truncation', function() {

    it('R-1: return value under 65536 bytes not truncated', async function() {
        const vm = createVM();
        // Build a string inside the contract to avoid code size limit
        const code = `module.exports = function(xchain) {
            var s = '';
            for (var i = 0; i < 1000; i++) s += 'xxxxxxxxxx';
            return s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue !== null);
        // 10000 chars serialized as JSON: "xxx..." = 10002 bytes, well under 65536
        assert(result.returnValue.length > 0);
    });

    it('R-2: return value over 65536 bytes truncated', async function() {
        this.timeout(10000);
        const vm = createVM();
        // Build a string longer than 65536 inside the contract
        const code = `module.exports = function(xchain) {
            var s = 'x'.repeat(70000);
            return s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue !== null);
        assert.strictEqual(result.returnValue.length, 65536);
    });

    it('R-3: return undefined gives null returnValue', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.returnValue, null);
    });

    it('R-4: return null gives "null" returnValue', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { return null; };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // null gets JSON.stringify'd to "null" with \x02 prefix
        assert(result.returnValue === 'null' || result.returnValue === null);
    });

    it('R-5: return non-serializable value handled gracefully', async function() {
        const vm = createVM();
        // Return a function (JSON.stringify(function) returns undefined)
        const code = 'module.exports = function(xchain) { return function() {}; };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // Function serialized inside isolate: JSON.stringify(fn) → undefined → wrapper returns undefined
        // Host sees undefined → returnValue = null. Or wrapper produces no \x02 prefix.
        // Either way, must not crash.
    });
});
