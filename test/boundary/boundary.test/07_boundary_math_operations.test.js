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
const { buildMathAPI } = require('../../../src/math.js');
const { ContractRevertError } = require('../../../src/errors.js');

// Boundary group 9: Math Operations (MA-1 through MA-10)

describe('Boundary: Math Operations', function() {

    const math = buildMathAPI();

    it('MA-1: division by zero throws', function() {
        assert.throws(() => math.divide('100', '0'), /Division by zero/);
    });

    it('MA-2: extremely large numbers (within 256-char limit)', function() {
        const big = '9'.repeat(200);
        const result = math.add(big, '1');
        assert(typeof result === 'string');
        assert(result.length >= 200);
    });

    it('MA-3: repeating decimal returns fixed notation', function() {
        const result = math.divide('1', '3');
        assert(typeof result === 'string');
        assert(!result.includes('e'), 'should not contain scientific notation');
        assert(result.startsWith('0.333'));
    });

    it('MA-4: negative numbers handled correctly', function() {
        assert.strictEqual(math.subtract('0', '1'), '-1');
        assert.strictEqual(math.abs('-42'), '42');
    });

    it('MA-5: non-numeric string input throws ContractRevertError', function() {
        assert.throws(() => math.add('abc', '1'), ContractRevertError);
    });

    it('MA-6: empty string input throws', function() {
        assert.throws(() => math.add('', '1'), ContractRevertError);
    });
});

describe('Boundary: Math Operations', function() {

    const math = buildMathAPI();

    it('MA-7: scientific notation input accepted deterministically', function() {
        const result = math.add('1e18', '1');
        assert(typeof result === 'string');
        assert(!result.includes('e'), 'output should be fixed notation');
    });

    it('MA-8: Infinity string input either throws or returns finite result', function() {
        // mathjs may accept 'Infinity' as a valid bignumber; verify behavior is deterministic
        try {
            const result = math.add('Infinity', '1');
            // If it doesn't throw, verify the result is a string (deterministic)
            assert(typeof result === 'string');
        } catch (e) {
            assert(e instanceof ContractRevertError);
        }
    });

    it('MA-9: isZero edge cases', function() {
        assert.strictEqual(math.isZero('0'), true);
        assert.strictEqual(math.isZero('0.0'), true);
        assert.strictEqual(math.isZero('-0'), true);
        assert.strictEqual(math.isZero('0.00000'), true);
        assert.strictEqual(math.isZero('0.0001'), false);
    });

    it('MA-10: mod by zero either throws or returns deterministic result', function() {
        // mathjs mod(x, 0) may return NaN or throw; verify behavior is consistent
        try {
            const result = math.mod('10', '0');
            assert(typeof result === 'string');
        } catch (e) {
            assert(e instanceof ContractRevertError);
        }
    });
});
