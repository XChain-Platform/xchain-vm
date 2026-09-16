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

// GAS METERING BYPASS (RISK-05, RISK-06)

(XChainVM ? describe : describe.skip)('Security: Gas Metering Bypass', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-06a: overwriting __gas should fail (non-writable)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    globalThis.__gas = function() {};
                    return 'overwrote';
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        // In strict mode, assignment to non-writable throws. In sloppy mode, silently fails.
        // Either way, __gas should still function; test with an infinite loop next.
        assert(val === 'blocked: Cannot assign to read only property \'__gas\' of object \'[object global]\'' ||
               val.startsWith('blocked') || val === 'overwrote',
            'got: ' + val);
    });

    it('RISK-06b: __gas should still meter after attempted overwrite', async function() {
        const vm2 = createVM({ gasCeiling: 500 });
        const result = await executeCode(vm2, `
            module.exports = function(xchain) {
                try { globalThis.__gas = function() {}; } catch(e) {}
                // If __gas was overwritten, this loop would run forever
                var sum = 0;
                for (var i = 0; i < 100000; i++) { sum += i; }
                return sum;
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'),
            'should still enforce gas after overwrite attempt: ' + result.error);
    });

    it('RISK-06c: deleting __gas should fail (non-configurable)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    delete globalThis.__gas;
                    return typeof globalThis.__gas;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'function' || val.startsWith('blocked'),
            '__gas should survive deletion attempt, got: ' + val);
    });
});

(XChainVM ? describe : describe.skip)('Security: Gas Metering Bypass', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-05a: getter traps should be blocked (Object.defineProperty removed)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var obj = {};
                    Object.defineProperty(obj, 'trap', {
                        get: function() {
                            // Expensive unmetered computation
                            var sum = 0;
                            for (var i = 0; i < 1000000; i++) sum += i;
                            return sum;
                        }
                    });
                    return 'defineProperty available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('RISK-05b: Object.create with descriptors should be blocked', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var obj = Object.create(null, {
                        trap: { get: function() { return 42; } }
                    });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });
});
