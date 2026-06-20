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
 * XChain VM: Deterministic Math
 *
 * Wraps mathjs bignumber for contract use. All inputs and outputs
 * are strings (no floating-point anywhere).
 ********************************************************************/
// @ts-nocheck

const { ContractRevertError } = require('./errors.js');
const mathjs = require('mathjs');
const { bignumber, add, subtract, multiply, divide, mod, compare } = mathjs;
const { pow, sqrt, log, log2, log10 } = mathjs;

// BigNumber precision is consensus-affecting (it determines every contract math root).
// In mathjs 15 the global config is READONLY, so precision is fixed at the library
// default (64) for a given mathjs version and cannot drift at runtime. The determinism
// guard pins the mathjs/decimal.js versions and asserts mathjs.config().precision in the
// consensus surface (consensus-runtime.js MATH_PINNED), so a dependency bump that would
// change this default cannot ship without a coordinated CONSENSUS_VERSION change.

// Maximum input length for math operations to prevent DoS via
// extreme-precision bignumber parsing (RISK-12, RISK-18).
const MAX_MATH_INPUT_LENGTH = 256;

// Format a bignumber result as a fixed-notation string (no scientific notation)
function toFixed(val) {
    return mathjs.format(val, { notation: 'fixed' });
}

// Format a result that must be a real, finite number. Transcendental functions
// (sqrt, pow, log, ...) can legitimately produce complex values (sqrt of a
// negative, fractional pow of a negative) or non-finite values (log of zero).
// Returning a "1+2i" or "Infinity" string from a numeric contract API is a
// footgun, so we reject those here. safeMath() turns the throw into a clean
// ContractRevertError.
function toRealFixed(val) {
    if (mathjs.isComplex(val))
        throw new Error('result is not a real number');
    const s = toFixed(val);
    if (s === 'Infinity' || s === '-Infinity' || s === 'NaN')
        throw new Error('result is not a finite number');
    return s;
}

function validateInput(val) {
    const s = String(val);
    if (s.length > MAX_MATH_INPUT_LENGTH)
        throw new Error('math input exceeds maximum length (' + MAX_MATH_INPUT_LENGTH + ' chars)');
    return s;
}

// Safely divide (mathjs returns Infinity for div by zero instead of throwing)
function safeDivide(a, b) {
    const bb = bignumber(validateInput(b));
    if (bb.isZero()) throw new Error('Division by zero');
    return divide(bignumber(validateInput(a)), bb);
}

// Compare and return a plain number (-1, 0, 1)
function cmp(a, b) {
    return Number(compare(bignumber(validateInput(a)), bignumber(validateInput(b))));
}

function safeMath(fn) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (e) {
            throw new ContractRevertError('math error: ' + e.message);
        }
    };
}

function buildMathAPI() {
    return {
        add:      safeMath((a, b) => toFixed(add(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        subtract: safeMath((a, b) => toFixed(subtract(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        multiply: safeMath((a, b) => toFixed(multiply(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        divide:   safeMath((a, b) => toFixed(safeDivide(a, b))),
        mod:      safeMath((a, b) => toFixed(mod(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        compare:  safeMath((a, b) => cmp(a, b)),
        gt:       safeMath((a, b) => cmp(a, b) > 0),
        gte:      safeMath((a, b) => cmp(a, b) >= 0),
        lt:       safeMath((a, b) => cmp(a, b) < 0),
        lte:      safeMath((a, b) => cmp(a, b) <= 0),
        eq:       safeMath((a, b) => cmp(a, b) === 0),
        min:      safeMath((a, b) => { const ba = bignumber(validateInput(a)), bb = bignumber(validateInput(b)); return toFixed(cmp(a, b) <= 0 ? ba : bb); }),
        max:      safeMath((a, b) => { const ba = bignumber(validateInput(a)), bb = bignumber(validateInput(b)); return toFixed(cmp(a, b) >= 0 ? ba : bb); }),
        abs:      safeMath((a)    => toFixed(bignumber(validateInput(a)).abs())),
        isZero:   safeMath((a)    => bignumber(validateInput(a)).isZero()),

        // Transcendental functions: deterministic, architecture-independent
        // replacements for the IEEE 754 Math.sqrt/pow/log/... that are no longer
        // exposed in the sandbox. mathjs bignumber is pure-software arithmetic,
        // so these produce bit-identical results on every CPU architecture.
        sqrt:     safeMath((a)    => toRealFixed(sqrt(bignumber(validateInput(a))))),
        pow:      safeMath((a, b) => toRealFixed(pow(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        log:      safeMath((a)    => toRealFixed(log(bignumber(validateInput(a))))),
        log2:     safeMath((a)    => toRealFixed(log2(bignumber(validateInput(a))))),
        log10:    safeMath((a)    => toRealFixed(log10(bignumber(validateInput(a)))))
    };
}

module.exports = { buildMathAPI };
