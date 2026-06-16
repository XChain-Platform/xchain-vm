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
 * Fuzz Tests — Math Operations
 *
 * Tests that xchain.math methods handle adversarial numeric inputs
 * without crashing, and that algebraic properties hold.
 ********************************************************************/
// @ts-nocheck

// 


const fc = require('fast-check');
const assert = require('assert');
const { XChainVM, createVM, execute, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('./invariants');
const {
    mathContractArb, divisionByZeroArb, commutativityArb,
    safeNumericStringArb, buildMathContract
} = require('./generators/math');

(XChainVM ? describe : describe.skip)('Fuzz: Math', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    it('any math input produces a valid result shape', async function() {
        await fc.assert(fc.asyncProperty(mathContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('division by zero always fails with math error', async function() {
        await fc.assert(fc.asyncProperty(divisionByZeroArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            assert.strictEqual(result.success, false, 'Division by zero should fail');
            assert(result.error.includes('math error') || result.error.includes('revert'),
                'Error should mention math error, got: ' + result.error);
        }), FC_OPTIONS);
    });

    it('add is commutative for valid inputs', async function() {
        await fc.assert(fc.asyncProperty(
            safeNumericStringArb, safeNumericStringArb,
            async (a, b) => {
                const code = `module.exports = function(xchain) {
                    var r1 = xchain.math.add(${JSON.stringify(a)}, ${JSON.stringify(b)});
                    var r2 = xchain.math.add(${JSON.stringify(b)}, ${JSON.stringify(a)});
                    return { r1: r1, r2: r2 };
                };`;
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const { r1, r2 } = JSON.parse(result.returnValue);
                    assert.strictEqual(r1, r2,
                        'add not commutative: add(' + a + ',' + b + ') = ' + r1 + ' vs ' + r2);
                }
            }
        ), FC_OPTIONS);
    });

    it('multiply is commutative for valid inputs', async function() {
        await fc.assert(fc.asyncProperty(
            safeNumericStringArb, safeNumericStringArb,
            async (a, b) => {
                const code = `module.exports = function(xchain) {
                    var r1 = xchain.math.multiply(${JSON.stringify(a)}, ${JSON.stringify(b)});
                    var r2 = xchain.math.multiply(${JSON.stringify(b)}, ${JSON.stringify(a)});
                    return { r1: r1, r2: r2 };
                };`;
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const { r1, r2 } = JSON.parse(result.returnValue);
                    assert.strictEqual(r1, r2,
                        'multiply not commutative: multiply(' + a + ',' + b + ') = ' + r1 + ' vs ' + r2);
                }
            }
        ), FC_OPTIONS);
    });

    it('compare is antisymmetric for valid inputs', async function() {
        await fc.assert(fc.asyncProperty(
            safeNumericStringArb, safeNumericStringArb,
            async (a, b) => {
                const code = `module.exports = function(xchain) {
                    var c1 = xchain.math.compare(${JSON.stringify(a)}, ${JSON.stringify(b)});
                    var c2 = xchain.math.compare(${JSON.stringify(b)}, ${JSON.stringify(a)});
                    return { c1: c1, c2: c2 };
                };`;
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const { c1, c2 } = JSON.parse(result.returnValue);
                    assert.strictEqual(c1, -c2,
                        'compare not antisymmetric: compare(' + a + ',' + b + ') = ' + c1 + ', compare(' + b + ',' + a + ') = ' + c2);
                }
            }
        ), FC_OPTIONS);
    });

    it('successful math results never contain scientific notation', async function() {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom('add', 'subtract', 'multiply'),
            safeNumericStringArb,
            safeNumericStringArb,
            async (op, a, b) => {
                const code = buildMathContract(op, a, b);
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const val = JSON.parse(result.returnValue);
                    if (typeof val === 'string' && val.includes('e')) {
                        throw new Error('Scientific notation in result: ' + val + ' for ' + op + '(' + a + ', ' + b + ')');
                    }
                }
            }
        ), FC_OPTIONS);
    });

    it('add(a, 0) equals a for integer strings', async function() {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: -999999, max: 999999 }).map(String),
            async (a) => {
                const code = `module.exports = function(xchain) {
                    return xchain.math.add(${JSON.stringify(a)}, '0');
                };`;
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const val = JSON.parse(result.returnValue);
                    assert.strictEqual(val, a,
                        'add(' + a + ', 0) = ' + val + ', expected ' + a);
                }
            }
        ), FC_OPTIONS);
    });

    it('subtract(add(a, b), b) equals a for small integers', async function() {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: -9999, max: 9999 }).map(String),
            fc.integer({ min: -9999, max: 9999 }).map(String),
            async (a, b) => {
                const code = `module.exports = function(xchain) {
                    var sum = xchain.math.add(${JSON.stringify(a)}, ${JSON.stringify(b)});
                    return xchain.math.subtract(sum, ${JSON.stringify(b)});
                };`;
                const result = await execute(vm, code);
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const val = JSON.parse(result.returnValue);
                    assert.strictEqual(val, a,
                        'subtract(add(' + a + ', ' + b + '), ' + b + ') = ' + val + ', expected ' + a);
                }
            }
        ), FC_OPTIONS);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
