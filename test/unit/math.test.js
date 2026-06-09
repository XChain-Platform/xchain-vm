// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const { buildMathAPI } = require('../../src/math.js');
const { ContractRevertError } = require('../../src/errors.js');

describe('Math API', function() {

    const math = buildMathAPI();

    describe('arithmetic', function() {
        it('should add correctly', function() {
            assert.strictEqual(math.add('1', '2'), '3');
        });

        it('should handle decimal precision (0.1 + 0.2)', function() {
            assert.strictEqual(math.add('0.1', '0.2'), '0.3');
        });

        it('should subtract correctly', function() {
            assert.strictEqual(math.subtract('10', '3'), '7');
        });

        it('should multiply correctly', function() {
            assert.strictEqual(math.multiply('6', '7'), '42');
        });

        it('should divide correctly', function() {
            assert.strictEqual(math.divide('10', '4'), '2.5');
        });

        it('should mod correctly', function() {
            assert.strictEqual(math.mod('10', '3'), '1');
        });

        it('should handle large numbers', function() {
            const big = '99999999999999999999999999999999999999999999999999';
            const result = math.add(big, '1');
            assert.strictEqual(result, '100000000000000000000000000000000000000000000000000');
        });

        it('should handle negative results', function() {
            assert.strictEqual(math.subtract('3', '10'), '-7');
        });
    });

    describe('comparison', function() {
        it('should compare correctly', function() {
            assert.strictEqual(math.compare('10', '5'), 1);
            assert.strictEqual(math.compare('5', '10'), -1);
            assert.strictEqual(math.compare('5', '5'), 0);
        });

        it('should return booleans for gt/gte/lt/lte/eq', function() {
            assert.strictEqual(math.gt('10', '5'), true);
            assert.strictEqual(math.gt('5', '10'), false);
            assert.strictEqual(math.gte('5', '5'), true);
            assert.strictEqual(math.lt('3', '5'), true);
            assert.strictEqual(math.lte('5', '5'), true);
            assert.strictEqual(math.eq('5', '5'), true);
            assert.strictEqual(math.eq('5', '6'), false);
        });
    });

    describe('utility', function() {
        it('should compute min/max', function() {
            assert.strictEqual(math.min('3', '7'), '3');
            assert.strictEqual(math.max('3', '7'), '7');
        });

        it('should compute abs', function() {
            assert.strictEqual(math.abs('-5'), '5');
            assert.strictEqual(math.abs('5'), '5');
        });

        it('should check isZero', function() {
            assert.strictEqual(math.isZero('0'), true);
            assert.strictEqual(math.isZero('1'), false);
        });
    });

    describe('transcendental (deterministic bignumber)', function() {
        it('should compute exact integer square roots', function() {
            assert.strictEqual(math.sqrt('4'), '2');
            assert.strictEqual(math.sqrt('144'), '12');
        });

        it('should compute sqrt of 2 deterministically', function() {
            const result = math.sqrt('2');
            // mathjs bignumber is pure software — identical on every architecture.
            assert(result.startsWith('1.4142135623730950488'), result);
        });

        it('should compute integer powers exactly', function() {
            assert.strictEqual(math.pow('2', '10'), '1024');
            assert.strictEqual(math.pow('5', '3'), '125');
        });

        it('should treat fractional pow(x, 0.5) as sqrt', function() {
            assert.strictEqual(math.pow('2', '0.5'), math.sqrt('2'));
        });

        it('should compute log2 and log10 of exact powers', function() {
            assert.strictEqual(math.log2('8'), '3');
            assert.strictEqual(math.log10('1000'), '3');
        });

        it('should compute natural log of 1 as 0', function() {
            assert.strictEqual(math.log('1'), '0');
        });

        it('should return strings from transcendental functions', function() {
            assert.strictEqual(typeof math.sqrt('9'), 'string');
            assert.strictEqual(typeof math.pow('2', '8'), 'string');
        });

        it('should revert on sqrt of a negative number (complex result)', function() {
            assert.throws(() => math.sqrt('-1'), ContractRevertError);
        });

        it('should revert on log of zero (non-finite result)', function() {
            assert.throws(() => math.log('0'), ContractRevertError);
        });

        it('should revert on log of a negative number (complex result)', function() {
            assert.throws(() => math.log('-5'), ContractRevertError);
        });

        it('should revert on fractional pow of a negative base (complex result)', function() {
            assert.throws(() => math.pow('-2', '0.5'), ContractRevertError);
        });
    });

    describe('error handling', function() {
        it('should throw ContractRevertError on division by zero', function() {
            assert.throws(() => {
                math.divide('1', '0');
            }, ContractRevertError);
        });

        it('should throw ContractRevertError on invalid input', function() {
            assert.throws(() => {
                math.add('abc', '1');
            }, ContractRevertError);
        });

        it('should include "math error:" in message', function() {
            try {
                math.divide('1', '0');
                assert.fail('should throw');
            } catch (e) {
                assert(e.message.startsWith('math error:'), 'message should start with "math error:"');
            }
        });
    });

    describe('string I/O', function() {
        it('should accept string inputs and return strings', function() {
            const result = math.add('100', '200');
            assert.strictEqual(typeof result, 'string');
            assert.strictEqual(result, '300');
        });

        it('should accept number-like strings', function() {
            assert.strictEqual(math.add('1e2', '0'), '100');
        });
    });

    describe('extended edge cases', function() {
        it('should not produce negative zero', function() {
            const result = math.subtract('1', '1');
            assert.strictEqual(result, '0');
            assert(!result.startsWith('-'), 'should not be negative zero');
        });

        it('should handle very large decimal precision', function() {
            const result = math.add('0.123456789012345678901234567890', '0.000000000000000000000000000001');
            assert(result.includes('12345678901234567890123456789'), 'should preserve precision');
        });

        it('should handle 100+ digit integers without overflow', function() {
            const big = '1' + '0'.repeat(100);
            const result = math.add(big, '0');
            // Should at least preserve the magnitude
            assert.strictEqual(result.length, 101);
            assert(result.startsWith('1'));
        });

        it('should handle mod with zero divisor', function() {
            // mathjs mod by zero returns NaN; toFixed produces 'NaN' string
            // The result is a string 'NaN' rather than throwing
            const result = math.mod('5', '0');
            assert.strictEqual(typeof result, 'string');
        });

        it('should handle mod with negative dividend', function() {
            const result = math.mod('-10', '3');
            assert.strictEqual(typeof result, 'string');
        });

        it('should return false for isZero with near-zero', function() {
            assert.strictEqual(math.isZero('0.0000000000000001'), false);
        });

        it('should return true for isZero with "0.00"', function() {
            assert.strictEqual(math.isZero('0.00'), true);
        });

        it('should return number type from compare', function() {
            assert.strictEqual(typeof math.compare('1', '2'), 'number');
        });

        it('should handle scientific notation in divide', function() {
            assert.strictEqual(math.divide('1e4', '1e2'), '100');
        });

        it('should format results in fixed notation (no scientific)', function() {
            const result = math.multiply('1e10', '1e10');
            assert(!result.includes('e'), 'should be fixed notation');
            assert.strictEqual(result, '100000000000000000000');
        });
    });

    describe('input length guard (MAX_MATH_INPUT_LENGTH)', function() {
        it('should throw ContractRevertError when input exceeds 256 chars', function() {
            const longNum = '1'.repeat(257);
            assert.throws(() => math.add(longNum, '1'), ContractRevertError);
        });

        it('should accept input exactly at 256 chars', function() {
            // 256 '0's followed by nothing is just '0' repeated
            const maxNum = '1' + '0'.repeat(255); // 256 chars
            const result = math.add(maxNum, '0');
            assert.strictEqual(typeof result, 'string');
        });

        it('should throw ContractRevertError when second input exceeds 256 chars', function() {
            const longNum = '9'.repeat(257);
            assert.throws(() => math.subtract('1', longNum), ContractRevertError);
        });
    });

    describe('min/max both branch orderings', function() {
        it('min should return a when a <= b', function() {
            assert.strictEqual(math.min('3', '7'), '3');
        });

        it('min should return b when a > b', function() {
            assert.strictEqual(math.min('9', '4'), '4');
        });

        it('min should return either when a === b', function() {
            assert.strictEqual(math.min('5', '5'), '5');
        });

        it('max should return b when a <= b', function() {
            assert.strictEqual(math.max('3', '7'), '7');
        });

        it('max should return a when a > b', function() {
            assert.strictEqual(math.max('9', '4'), '9');
        });

        it('max should return either when a === b', function() {
            assert.strictEqual(math.max('5', '5'), '5');
        });
    });
});
