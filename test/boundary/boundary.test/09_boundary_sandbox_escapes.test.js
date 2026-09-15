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

// Boundary group 11: Sandbox Escape Boundaries (SB-1 through SB-8)

(XChainVM ? describe : describe.skip)('Boundary: Sandbox Escapes', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('SB-1: stripped globals return undefined', async function() {
        const code = `module.exports = function(xchain) {
            return {
                process: typeof process,
                require: typeof require,
                fetch: typeof fetch
            };
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed.process, 'undefined');
        assert.strictEqual(parsed.require, 'undefined');
        assert.strictEqual(parsed.fetch, 'undefined');
    });

    it('SB-2: Function constructor escape blocked', async function() {
        const code = `module.exports = function(xchain) {
            try {
                var fn = (function(){}).constructor;
                var global = fn('return this')();
                return 'escaped: ' + typeof global.process;
            } catch(e) {
                return 'blocked: ' + e.message;
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // Should either be blocked or return undefined for process
        assert(
            result.returnValue.includes('blocked') ||
            result.returnValue.includes('undefined'),
            'should not access host process: ' + result.returnValue
        );
    });

    it('SB-3: globalThis cleaned of injected references', async function() {
        const code = `module.exports = function(xchain) {
            var names = Object.getOwnPropertyNames(globalThis);
            var leaked = names.filter(function(n) {
                return n.indexOf('__state') === 0 ||
                       n.indexOf('__emit') === 0 ||
                       n.indexOf('__oracle') === 0 ||
                       n.indexOf('__crossChain') === 0 ||
                       n.indexOf('__getB') === 0;
            });
            return leaked;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const leaked = JSON.parse(result.returnValue);
        assert.strictEqual(leaked.length, 0, 'should not leak internal references: ' + result.returnValue);
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Sandbox Escapes', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('SB-4: prototype pollution does not affect host', async function() {
        const code = `module.exports = function(xchain) {
            Object.prototype.polluted = true;
            return 'done';
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(({}).polluted, undefined, 'host Object.prototype must not be polluted');
    });

    it('SB-5: indirect eval blocked', async function() {
        const code = `module.exports = function(xchain) {
            try {
                var e = eval;
                return 'eval result: ' + e('1+1');
            } catch(err) {
                return 'blocked';
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('blocked') || result.returnValue === '"blocked"',
            'indirect eval should be blocked: ' + result.returnValue);
    });

    it('SB-6: Date is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof Date;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'Date should be stripped: ' + result.returnValue);
    });

    it('SB-7: Math.random is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof Math.random;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'Math.random should be stripped: ' + result.returnValue);
    });

    it('SB-8: SharedArrayBuffer is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof SharedArrayBuffer;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'SharedArrayBuffer should be stripped: ' + result.returnValue);
    });
});
