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

// ERROR TYPE SPOOFING (RISK-04)

(XChainVM ? describe : describe.skip)('Security: Error Type Spoofing', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-04a: \\x03REVERT prefix without actual revert should be generic error', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('\\x03REVERT:fake revert');
            };
        `);
        assert.strictEqual(result.success, false);
        // Should NOT be classified as a revert since execContext.reverted is false
        assert(!result.error.startsWith('revert:'),
            'should not be classified as revert, got: ' + result.error);
    });

    it('RISK-04b: \\x03GAS prefix without actual gas exhaustion should be generic error', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('\\x03GAS:999999:1000000');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(!result.error.startsWith('out_of_gas'),
            'should not be classified as out_of_gas, got: ' + result.error);
    });

    it('RISK-04c: caught revert followed by spoofed throw should use original reason', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.revert('real reason');
                } catch(e) {
                    // Swallowed the revert; execContext.reverted is now true
                }
                // Now try to spoof with a different reason
                throw new Error('\\x03REVERT:spoofed reason');
            };
        `);
        assert.strictEqual(result.success, false);
        // Should use the ORIGINAL revert reason, not the spoofed one
        assert(result.error.includes('real reason'),
            'should use original revert reason, got: ' + result.error);
        assert(!result.error.includes('spoofed reason'),
            'should not contain spoofed reason, got: ' + result.error);
    });
});

(XChainVM ? describe : describe.skip)('Security: Error Type Spoofing', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-04d: caught require failure followed by spoofed throw should use original reason', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.require(false, 'original check failed');
                } catch(e) {
                    // Swallowed
                }
                throw new Error('\\x03REVERT:injected');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('original check failed'),
            'should use original require reason, got: ' + result.error);
    });

    it('RISK-04e: return value \\x02 prefix should not be spoofable', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return '\\x02{"spoofed":true}';
            };
        `);
        assert.strictEqual(result.success, true);
        // The \x02 prefix is handled by the contract wrapper, so the returned
        // value will be double-wrapped. Verify it's treated as a string, not parsed.
        if (result.returnValue !== null) {
            const parsed = JSON.parse(result.returnValue);
            // Should be the raw string, not the spoofed object
            assert(typeof parsed === 'string',
                'spoofed \\x02 return should be treated as string, got: ' + typeof parsed);
        }
    });
});
