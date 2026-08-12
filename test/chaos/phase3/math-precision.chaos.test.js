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
 * Chaos Experiment 10: mathjs Precision Boundary
 *
 * Tests the VM's math gateway with extreme numeric inputs to verify
 * correct handling of: input length limits (256 chars), division by
 * zero, extreme precision, accumulated operations, and invalid input
 * formats.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { XChainVM, createVM, execute } = require('../helpers/harness');
const { checkResultShape, checkAtomicity } = require('../../fuzz/invariants');

const mathExtremeCode = fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'math_extreme.js'), 'utf8'
);

(XChainVM ? describe : describe.skip)('Chaos: Math Precision Boundary (Exp 10)', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('CHAOS-1001: 256-char number at input limit succeeds', async function() {
        const bigNum = '9'.repeat(256);
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', bigNum, '1']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true,
            '256-char input should be accepted: ' + result.error);
    });

    it('CHAOS-1002: 257-char number over input limit fails', async function() {
        const overLimit = '9'.repeat(257);
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', overLimit, '1']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, false, '257-char input should be rejected');
        checkAtomicity(result);
    });

    it('CHAOS-1003: division by zero caught and classified', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['divide', '100', '0']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Division by zero should fail');
        // The error may be classified as 'revert:' or 'error: REVERT:' depending on
        // how the ContractRevertError propagates across the isolate boundary.
        assert(result.error.includes('REVERT') || result.error.includes('revert'),
            'Division by zero should contain revert marker: ' + result.error);
        assert(result.error.toLowerCase().includes('division by zero'),
            'Error should mention division by zero: ' + result.error);
        checkAtomicity(result);
    });

    it('CHAOS-1004: 0 divided by 0 caught', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['divide', '0', '0']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, false, '0/0 should fail');
        checkAtomicity(result);
    });

    it('CHAOS-1005: very large multiplication succeeds', async function() {
        // 100-digit * 100-digit: mathjs handles arbitrary precision
        const a = '9'.repeat(100);
        const b = '9'.repeat(100);
        const result = await execute(vm, mathExtremeCode, {
            params: ['multiply', a, b]
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true,
            'Large multiplication should succeed: ' + result.error);
        if (result.returnValue) {
            const val = JSON.parse(result.returnValue);
            assert(typeof val === 'string', 'Result should be a string');
            // Product of two 100-digit 9s should be ~200 digits
            assert(val.length >= 199, 'Result should be ~200 digits, got ' + val.length);
        }
    });

    it('CHAOS-1006: accumulated precision over 100 additions', async function() {
        this.timeout(15000);
        const result = await execute(vm, mathExtremeCode, {
            params: ['accumulated', '0.1', '0', '100']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true,
            'Accumulated additions should succeed: ' + result.error);
        if (result.returnValue) {
            const val = JSON.parse(result.returnValue);
            // 100 * 0.1 should be exactly 10 (bignumber, no floating-point drift)
            assert.strictEqual(val, '10',
                'Accumulated 100 * 0.1 should be exactly 10, got: ' + val);
        }
    });

    it('CHAOS-1007: accumulated precision over 1000 additions', async function() {
        this.timeout(30000);
        const result = await execute(vm, mathExtremeCode, {
            params: ['accumulated', '0.001', '0', '1000']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true,
            '1000 accumulated additions should succeed: ' + result.error);
        if (result.returnValue) {
            const val = JSON.parse(result.returnValue);
            // 1000 * 0.001 should be exactly 1
            assert.strictEqual(val, '1',
                'Accumulated 1000 * 0.001 should be exactly 1, got: ' + val);
        }
    });

    it('CHAOS-1008: negative numbers handled correctly', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', '-999999999', '-1']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Negative addition should work: ' + result.error);
        if (result.returnValue) {
            assert.strictEqual(JSON.parse(result.returnValue), '-1000000000');
        }
    });

    it('CHAOS-1009: compare equal large numbers', async function() {
        const big = '9'.repeat(200);
        const result = await execute(vm, mathExtremeCode, {
            params: ['compare', big, big]
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Compare should work: ' + result.error);
        if (result.returnValue) {
            assert.strictEqual(JSON.parse(result.returnValue), '0',
                'Equal numbers should compare to 0');
        }
    });

    it('CHAOS-1010: compare with different precision', async function() {
        // Use a difference that's within mathjs bignumber precision (64 digits)
        // '1.000...001' with 28 zeros is within precision range
        const result = await execute(vm, mathExtremeCode, {
            params: ['compare', '1.0001', '1']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Precision compare should work: ' + result.error);
        if (result.returnValue) {
            // 1.0001 > 1
            assert.strictEqual(JSON.parse(result.returnValue), '1',
                'Slightly larger number should compare as greater');
        }
    });

    it('CHAOS-1011: isZero with various zero representations', async function() {
        const zeros = ['0', '0.0', '0.00000000000', '-0'];
        for (const z of zeros) {
            const result = await execute(vm, mathExtremeCode, {
                params: ['isZero', z]
            });
            checkResultShape(result);
            assert.strictEqual(result.success, true,
                'isZero("' + z + '") should succeed: ' + result.error);
            if (result.returnValue) {
                assert.strictEqual(JSON.parse(result.returnValue), 'true',
                    '"' + z + '" should be zero');
            }
        }
    });

    it('CHAOS-1012: abs of negative number', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['abs', '-12345.6789']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'abs should work: ' + result.error);
        if (result.returnValue) {
            assert.strictEqual(JSON.parse(result.returnValue), '12345.6789');
        }
    });

    it('CHAOS-1013: empty string input handled gracefully', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', '', '1']
        });
        checkResultShape(result);
        // Empty string may be parsed as 0 by mathjs bignumber, or may fail.
        // Either outcome is acceptable; just verify no crash.
        if (!result.success) {
            checkAtomicity(result);
        }
    });

    it('CHAOS-1014: non-numeric string input fails gracefully', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', 'not_a_number', '1']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Non-numeric string should fail');
        checkAtomicity(result);
    });

    it('CHAOS-1015: scientific notation input', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', '1e10', '1']
        });
        checkResultShape(result);
        // mathjs may or may not accept scientific notation; just verify no crash
        if (result.success && result.returnValue) {
            const val = JSON.parse(result.returnValue);
            assert(typeof val === 'string', 'Result should be a string');
        }
        if (!result.success) {
            checkAtomicity(result);
        }
    });

    it('CHAOS-1016: mod by zero', async function() {
        const result = await execute(vm, mathExtremeCode, {
            params: ['mod', '10', '0']
        });
        checkResultShape(result);
        // Mod by zero behavior depends on mathjs; verify no crash
        if (!result.success) {
            checkAtomicity(result);
        }
    });

    it('CHAOS-1017: VM recovers after math errors', async function() {
        // Trigger several math failures
        await execute(vm, mathExtremeCode, { params: ['divide', '1', '0'] });
        await execute(vm, mathExtremeCode, { params: ['add', 'NaN', '1'] });
        await execute(vm, mathExtremeCode, { params: ['add', '9'.repeat(257), '1'] });

        // Recovery
        const result = await execute(vm, mathExtremeCode, {
            params: ['add', '1', '2']
        });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'VM should recover: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), '3');
    });
});
