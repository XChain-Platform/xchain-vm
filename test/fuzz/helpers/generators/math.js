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
 * Fuzz Generators: Math Operations
 *
 * Generates adversarial numeric inputs for xchain.math methods.
 ********************************************************************/
// @ts-nocheck

const fc = require('fast-check');

const MATH_BINARY_OPS = [
    'add', 'subtract', 'multiply', 'divide', 'mod',
    'compare', 'gt', 'gte', 'lt', 'lte', 'eq', 'min', 'max'
];
const MATH_UNARY_OPS = ['abs', 'isZero'];
const MATH_ALL_OPS = [...MATH_BINARY_OPS, ...MATH_UNARY_OPS];

const safeNumericStringArb = fc.oneof(
    fc.integer({ min: -999999999, max: 999999999 }).map(String),
    fc.tuple(
        fc.integer({ min: -99999, max: 99999 }),
        fc.nat({ max: 99999 })
    ).map(([whole, frac]) => whole + '.' + frac)
);

const edgeCaseNumericArb = fc.constantFrom(
    '0', '-0', '0.0', '-0.0',
    '1', '-1', '0.1', '-0.1',
    '1e18', '-1e18', '1e-18',
    '999999999999999999999999999999',
    '-999999999999999999999999999999',
    '0.' + '0'.repeat(50) + '1',
    String(Number.MAX_SAFE_INTEGER),
    String(Number.MIN_SAFE_INTEGER),
    '9'.repeat(100),
    '0.' + '9'.repeat(100)
);

const invalidNumericArb = fc.constantFrom(
    '', 'abc', 'NaN', 'Infinity', '-Infinity',
    'null', 'undefined', 'true', 'false',
    '1.1.1', '1e', 'e5', '++1', '--1',
    '\x00', '\x01', ' ', '  1  ',
    '1,000', '$100', '1_000',
    '[]', '{}', 'function(){}',
    '.', '-', '+', '+-1'
);

const anyNumericArb = fc.oneof(
    { weight: 4, arbitrary: safeNumericStringArb },
    { weight: 3, arbitrary: edgeCaseNumericArb },
    { weight: 3, arbitrary: invalidNumericArb }
);

function buildMathContract(op, a, b) {
    if (MATH_UNARY_OPS.includes(op)) {
        return 'module.exports = function(xchain) {\n' +
            '    return xchain.math.' + op + '(' + JSON.stringify(a) + ');\n' +
            '};';
    }
    return 'module.exports = function(xchain) {\n' +
        '    return xchain.math.' + op + '(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ');\n' +
        '};';
}

function buildCommutativityContract(op, a, b) {
    return 'module.exports = function(xchain) {\n' +
        '    var r1 = xchain.math.' + op + '(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ');\n' +
        '    var r2 = xchain.math.' + op + '(' + JSON.stringify(b) + ', ' + JSON.stringify(a) + ');\n' +
        '    return { r1: r1, r2: r2, equal: r1 === r2 };\n' +
        '};';
}

const mathContractArb = fc.tuple(
    fc.constantFrom(...MATH_ALL_OPS),
    anyNumericArb,
    anyNumericArb
).map(([op, a, b]) => buildMathContract(op, a, b));

const binaryMathContractArb = fc.tuple(
    fc.constantFrom(...MATH_BINARY_OPS),
    anyNumericArb,
    anyNumericArb
).map(([op, a, b]) => buildMathContract(op, a, b));

const divisionByZeroArb = fc.tuple(
    safeNumericStringArb,
    fc.constantFrom('0', '-0', '0.0', '0.00', '-0.0')
).map(([a, b]) => buildMathContract('divide', a, b));

const commutativityArb = fc.tuple(
    fc.constantFrom('add', 'multiply', 'eq', 'min', 'max'),
    safeNumericStringArb,
    safeNumericStringArb
).map(([op, a, b]) => ({ code: buildCommutativityContract(op, a, b), op, a, b }));

module.exports = {
    MATH_BINARY_OPS,
    MATH_UNARY_OPS,
    MATH_ALL_OPS,
    safeNumericStringArb,
    edgeCaseNumericArb,
    invalidNumericArb,
    anyNumericArb,
    mathContractArb,
    binaryMathContractArb,
    divisionByZeroArb,
    commutativityArb,
    buildMathContract
};
