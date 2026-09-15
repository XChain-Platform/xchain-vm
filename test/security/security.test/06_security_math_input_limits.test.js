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

// MATH INPUT ABUSE (RISK-12)

(XChainVM ? describe : describe.skip)('Security: Math Input Limits', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-12a: should reject math input longer than 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1';
                for (var i = 0; i < 300; i++) big += '0';
                try {
                    xchain.math.add(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val.startsWith('rejected') && val.includes('maximum length'),
            'should reject oversized input, got: ' + val);
    });

    it('RISK-12b: should accept math input at exactly 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var num = '1';
                for (var i = 0; i < 255; i++) num += '0';
                try {
                    var r = xchain.math.add(num, '0');
                    return 'ok';
                } catch(e) {
                    return 'error: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'ok');
    });

    it('RISK-12c: should reject oversized input in divide', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1' + '0'.repeat(300);
                try {
                    xchain.math.divide(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });
});

(XChainVM ? describe : describe.skip)('Security: Math Input Limits', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-12d: should reject oversized input in compare', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1' + '0'.repeat(300);
                try {
                    xchain.math.compare(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    it('RISK-12e: should reject oversized input in abs', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '-' + '1'.repeat(300);
                try {
                    xchain.math.abs(big);
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    it('RISK-12f: should reject oversized input in isZero', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '0'.repeat(300);
                try {
                    xchain.math.isZero(big);
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });
});

(XChainVM ? describe : describe.skip)('Security: Math Input Limits', function() {

    // Unit-level math validation
    describe('Math module unit tests', function() {
        const { buildMathAPI } = require('../../../src/math.js');
        const math = buildMathAPI();

        it('should accept normal numeric strings', function() {
            assert.strictEqual(math.add('100', '200'), '300');
        });

        it('should reject input exceeding 256 chars', function() {
            const big = '1' + '0'.repeat(300);
            assert.throws(() => math.add(big, '1'), /maximum length/);
        });

        it('should reject oversized second argument', function() {
            const big = '1' + '0'.repeat(300);
            assert.throws(() => math.add('1', big), /maximum length/);
        });
    });
});
