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
const GasTracker = require('../../src/gas.js');
const { meterCode } = require('../../src/metering.js');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
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

// Section 1: Gas Ceiling Enforcement (G-1 through G-7)

describe('Boundary: Gas Ceiling', function() {

    const LIMITS = {
        maxStateKeys: 100,
        maxStateValueSize: 1024
    };

    it('G-1: gas used exactly at ceiling (unit level)', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 100);
        tracker.charge(100);
        assert.strictEqual(tracker.getUsed(), 100);
    });

    it('G-2: gas used one unit above ceiling (unit level)', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 100);
        assert.throws(() => tracker.charge(101));
    });

    it('G-3: gas ceiling of 1', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 1);
        tracker.charge(1); // exactly at ceiling (allowed)
        assert.throws(() => tracker.charge(1)); // one more over: rejected
    });

    it('G-4: gas ceiling of 0 rejects first charge', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 0);
        assert.throws(() => tracker.chargeComputation());
    });

    it('G-5: gas exactly at ceiling after mixed operations', function() {
        // ceiling = 1 + 200 + 100 = 301 (1 computation + 1 write + 1 read)
        const tracker = new GasTracker(GAS_SCHEDULE, 301);
        tracker.chargeComputation();                // 1
        tracker.charge(GAS_SCHEDULE.VM_STATE_WRITE); // 201
        tracker.charge(GAS_SCHEDULE.VM_STATE_READ);  // 301
        assert.strictEqual(tracker.getUsed(), 301);
    });

    it('G-6: gas overflow after mixed operations discards atomically', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 300);
        tracker.chargeComputation();                // 1
        tracker.charge(GAS_SCHEDULE.VM_STATE_WRITE); // 201
        assert.throws(() => tracker.charge(GAS_SCHEDULE.VM_STATE_READ)); // 301 > 300
    });

    it('G-7: negative gas schedule values rejected in constructor', function() {
        assert.throws(
            () => new GasTracker({ ...GAS_SCHEDULE, VM_COMPUTATION: -1 }, 1000),
            /non-negative integer/
        );
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Gas Ceiling (integration)', function() {

    it('G-1i: contract succeeds when gas used equals ceiling', async function() {
        // Find exact base gas cost of a minimal contract
        const vm = createVM({ gasCeiling: 1000000 });
        const code = 'module.exports = function(xchain) {};';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const baseCost = result.gasUsed;

        // Now set ceiling exactly to base cost
        const vm2 = createVM({ gasCeiling: baseCost });
        const result2 = await executeCode(vm2, code);
        assert.strictEqual(result2.success, true);
        assert.strictEqual(result2.gasUsed, baseCost);
    });

    it('G-2i: contract fails when gas ceiling is too low for a state write', async function() {
        // A state write costs VM_STATE_WRITE (200) + computation overhead.
        // With a ceiling of 10, the contract should fail.
        const vm = createVM({ gasCeiling: 10 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('key', 'value');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert(result.gasUsed > 0, 'should have used some gas before failing');
    });

    it('G-4i: gas ceiling 1 fails for non-trivial contract', async function() {
        // gasCeiling: 0 is treated as default by the constructor (||).
        // gasCeiling: 1 allows at most 1 unit of computation.
        const vm = createVM({ gasCeiling: 1 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('key', 'value');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
    });
});

// Section 2: Wall-Clock Timeout (T-1 through T-4)

(XChainVM ? describe : describe.skip)('Boundary: Wall-Clock Timeout', function() {

    it('T-2: infinite loop with high gas ceiling triggers timeout', async function() {
        this.timeout(15000);
        const vm = createVM({ gasCeiling: 999999999, maxCpuTimeMs: 1000 });
        // Tight loop that charges minimal gas; timeout should fire first
        const code = `module.exports = function(xchain) {
            while (true) {}
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(
            result.error.includes('timeout') || result.error.includes('out_of_gas'),
            'should timeout or run out of gas: ' + result.error
        );
    });

    it('T-3: timeout of 1ms fails most contracts', async function() {
        this.timeout(10000);
        const vm = createVM({ maxCpuTimeMs: 1 });
        const code = `module.exports = function(xchain) {
            var sum = 0;
            for (var i = 0; i < 100000; i++) sum += i;
            return sum;
        };`;
        const result = await executeCode(vm, code);
        // May succeed (tiny contract) or fail; must not crash
        assert(typeof result.success === 'boolean');
    });

    it('T-4: timeout of 0ms does not crash', async function() {
        this.timeout(10000);
        const vm = createVM({ maxCpuTimeMs: 0 });
        const code = 'module.exports = function(xchain) { return 1; };';
        const result = await executeCode(vm, code);
        // Must return a valid result object, not crash
        assert(typeof result.success === 'boolean');
        assert('error' in result);
        assert('gasUsed' in result);
    });
});

// Section 3: Memory Limits (M-1 through M-4)

(XChainVM ? describe : describe.skip)('Boundary: Memory Limits', function() {

    it('M-2: memory bomb exceeds limit gracefully', async function() {
        this.timeout(10000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            var s = 'x';
            for (var i = 0; i < 30; i++) s = s + s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        // Could be OOM, gas, timeout, or V8 string length error; all are acceptable
        assert(result.error.includes('error') || result.error.includes('out_of'),
            'should fail gracefully: ' + result.error);
    });

    it('M-4: many small allocations exceeding limit', async function() {
        this.timeout(10000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            var arr = [];
            for (var i = 0; i < 1000000; i++) arr.push('item_' + i);
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
    });
});

// Section 4: Code Size (CS-1 through CS-6)

(XChainVM ? describe : describe.skip)('Boundary: Code Size', function() {

    it('CS-1: code at exactly maxCodeSize executes', async function() {
        const vm = createVM();
        const header = 'module.exports = function(xchain) { /* ';
        const footer = ' */ };';
        const padding = 65536 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert.strictEqual(Buffer.byteLength(code, 'utf8'), 65536);
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });

    it('CS-2: code at maxCodeSize + 1 byte is rejected', async function() {
        const vm = createVM();
        const header = 'module.exports = function(xchain) { /* ';
        const footer = ' */ };';
        const padding = 65537 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert.strictEqual(Buffer.byteLength(code, 'utf8'), 65537);
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('code size exceeds limit'), result.error);
    });

    it('CS-3: empty code fails gracefully', async function() {
        const vm = createVM();
        const result = await executeCode(vm, '');
        assert.strictEqual(result.success, false);
        assert(result.error.includes('error:'), result.error);
    });

    it('CS-4: single semicolon fails with export error', async function() {
        const vm = createVM();
        const result = await executeCode(vm, ';');
        assert.strictEqual(result.success, false);
        assert(result.error.includes('error:'), result.error);
    });

    it('CS-5: extremely long single line (comment padding) parses and executes', async function() {
        const vm = createVM({ maxCodeSize: 70000 });
        // Long single line via comment padding (avoids gas explosion from many expressions)
        const header = 'module.exports = function(xchain) { return 42; /* ';
        const footer = ' */ };';
        const padding = 60000 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert(!code.includes('\n'), 'should be a single line');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });
});

describe('Boundary: Code Size (metering)', function() {

    it('CS-6: worst-case metered code completes in reasonable time', function() {
        this.timeout(10000);
        // Many nested ternaries to maximize AST node count
        let expr = '1';
        for (let i = 0; i < 200; i++) {
            expr = '(1 ? ' + expr + ' : 0)';
        }
        const code = 'module.exports = function(xchain) { return ' + expr + '; };';
        const start = Date.now();
        const metered = meterCode(code);
        const elapsed = Date.now() - start;
        assert(typeof metered === 'string');
        assert(elapsed < 5000, 'metering took too long: ' + elapsed + 'ms');
    });
});
