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
 * [P2] Core Functional Regression Tests
 *
 * Gas metering injection, state operations, all 16 emit types,
 * deterministic math, syntax and action validation.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { buildMathAPI } = require('../../../src/math.js');

describe('[P2] Functional Regression', function() {
    // DETERMINISTIC MATH
    describe('Deterministic math', function() {

        const math = buildMathAPI();

        it('should handle basic arithmetic', function() {
            assert.strictEqual(math.add('1', '2'), '3');
            assert.strictEqual(math.subtract('10', '3'), '7');
            assert.strictEqual(math.multiply('6', '7'), '42');
            assert.strictEqual(math.divide('10', '4'), '2.5');
            assert.strictEqual(math.mod('10', '3'), '1');
        });

        it('should handle decimal precision (0.1 + 0.2 = 0.3)', function() {
            assert.strictEqual(math.add('0.1', '0.2'), '0.3');
        });

        it('should handle large numbers', function() {
            const big = '99999999999999999999999999999999999999999999999999';
            assert.strictEqual(math.add(big, '1'),
                '100000000000000000000000000000000000000000000000000');
        });

        it('should provide correct comparisons', function() {
            assert.strictEqual(math.compare('10', '5'), 1);
            assert.strictEqual(math.compare('5', '10'), -1);
            assert.strictEqual(math.compare('5', '5'), 0);
            assert.strictEqual(math.gt('10', '5'), true);
            assert.strictEqual(math.lt('5', '10'), true);
            assert.strictEqual(math.eq('5', '5'), true);
        });

        it('should revert on division by zero', function() {
            assert.throws(() => math.divide('1', '0'));
        });

        it('should reject inputs exceeding 256 chars', function() {
            assert.throws(() => math.add('1'.repeat(257), '1'));
        });
    });
});
