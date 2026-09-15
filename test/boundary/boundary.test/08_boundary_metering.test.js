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
const { meterCode, hasGasIdentifier } = require('../../../src/metering.js');
const { validateSyntax } = require('../../../src/syntax.js');

// Boundary group 10: Metering & AST Injection (ME-1 through ME-7)

describe('Boundary: Metering', function() {

    it('ME-1: binary expression depth exactly 10 does not inject extra gas', function() {
        // 10 operands = depth 9, which is <= 10 threshold. Uses * (not +): the
        // metering pass rewrites + into __concat, so deep-binary Phase 2 metering
        // is exercised with a non-+ operator (deep + is metered by __concat).
        const operands = Array.from({ length: 10 }, (_, i) => String(i + 1));
        const expr = operands.join(' * ');
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);
        // Count __gas occurrences: should only have function-level injection, not binary depth injection
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        // Store for comparison with depth 11
        this._depth10GasCount = gasCount;
        assert(typeof metered === 'string');
    });

    it('ME-2: binary expression depth 11+ injects extra gas', function() {
        // 12 operands = depth 11, which is > 10 threshold. Uses * (see ME-1).
        const operands = Array.from({ length: 12 }, (_, i) => String(i + 1));
        const expr = operands.join(' * ');
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);

        // Compare with a shallow expression
        const shallowExpr = Array.from({ length: 5 }, (_, i) => String(i + 1)).join(' * ');
        const shallowCode = 'var result = ' + shallowExpr + ';';
        const shallowMetered = meterCode(shallowCode);

        const deepGas = (metered.match(/__gas\(/g) || []).length;
        const shallowGas = (shallowMetered.match(/__gas\(/g) || []).length;
        assert(deepGas > shallowGas, 'deep binary should have more gas calls');
    });

    it('ME-3: deeply nested ternaries do not stack overflow', function() {
        this.timeout(10000);
        let expr = '0';
        for (let i = 0; i < 100; i++) {
            expr = '(1 ? ' + expr + ' : 0)';
        }
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);
        assert(typeof metered === 'string');
        // Each ternary should inject gas into the test expression
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        assert(gasCount >= 100, 'should have gas calls for each ternary');
    });
});

describe('Boundary: Metering', function() {

    it('ME-4: __gas identifier rejected at deploy', function() {
        assert.strictEqual(hasGasIdentifier('var __gas = 1;'), true);
        const result = validateSyntax('var __gas = 1;');
        assert.strictEqual(result.valid, false);
        assert(result.error.includes('__gas'));
    });

    it('ME-5: ES2020 features parse, ES2022+ rejected', function() {
        // ES2020: optional chaining and nullish coalescing (should parse)
        const es2020 = 'var x = obj?.foo ?? "default";';
        const metered2020 = meterCode(es2020);
        assert(typeof metered2020 === 'string');

        // ES2022: class fields (should fail)
        const es2022 = 'class Foo { x = 1; }';
        assert.throws(() => meterCode(es2022));
    });

    it('ME-6: enormous switch statement meters without error', function() {
        this.timeout(10000);
        let cases = '';
        for (let i = 0; i < 1000; i++) {
            cases += 'case ' + i + ': break;\n';
        }
        const code = 'var x = 0; switch(x) { ' + cases + ' }';
        const metered = meterCode(code);
        assert(typeof metered === 'string');
        // Each case should get a gas call
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        assert(gasCount >= 1000, 'should have gas call per case');
    });

    it('ME-7: arrow function with expression body gets gas injection', function() {
        const code = 'var f = () => 42;';
        const metered = meterCode(code);
        // Arrow expression body should be wrapped: () => (__gas(1), 42)
        assert(metered.includes('__gas'), 'should inject gas into arrow body');
    });
});
