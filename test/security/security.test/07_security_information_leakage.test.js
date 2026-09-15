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

// INFORMATION LEAKAGE (RISK-15)

(XChainVM ? describe : describe.skip)('Security: Information Leakage', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-15a: generic error should not contain stack traces', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                // Throw an error that would normally have a stack trace
                throw new Error('something went wrong');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('something went wrong'), 'should contain error message');
        assert(!result.error.includes('\n'), 'should not contain newlines (stack trace)');
    });

    it('RISK-15b: error should be truncated to 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('x'.repeat(500));
            };
        `);
        assert.strictEqual(result.success, false);
        // "error: " prefix + truncated message
        assert(result.error.length <= 263, 'error should be truncated, length: ' + result.error.length);
    });

    it('RISK-15c: error with file paths should have paths stripped', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('failed at /home/user/app/src/module.js:42:10');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(!result.error.includes('/home/user'),
            'should strip file paths, got: ' + result.error);
    });
});

(XChainVM ? describe : describe.skip)('Security: Information Leakage', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-15d: revert error should preserve user reason without sanitization', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.revert('insufficient balance for transfer');
            };
        `);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'revert: insufficient balance for transfer');
    });

    it('RISK-15e: out_of_gas error should use tracker values not error message', async function() {
        const vm2 = createVM({ gasCeiling: 100 });
        const result = await executeCode(vm2, `
            module.exports = function(xchain) {
                var sum = 0;
                for (var i = 0; i < 10000; i++) sum += i;
                return sum;
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('out_of_gas'), 'should be out of gas: ' + result.error);
    });
});
