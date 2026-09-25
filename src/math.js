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

const { ContractRevertError, GasExhaustedError } = require('./errors.js');
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

// F-MO: the 256-char INPUT cap bounds add/subtract/multiply/divide/mod/sqrt/log
// (their outputs cannot exceed ~input magnitude), but it does NOT bound pow: a
// tiny exponent yields an astronomically large magnitude (pow('10','10000000')
// is a 10-million-digit result from a 10-char input). The math API runs
// HOST-SIDE via ivm.Reference, so mathjs.format() expanding that value allocates
// tens of MB (or OOM-crashes the node at pow('10','1e9')) OUTSIDE the isolate's
// gas ceiling, 8MB memory limit, and wall-clock net, for ~0 gas: an unmetered
// host DoS / crash-on-demand. Charge gas proportional to the result's predicted
// fixed-notation length BEFORE format() runs, so an oversized result trips the
// deterministic gas ceiling (out_of_gas) instead of the allocator. The predicted
// length is derived from the bignumber's decimal exponent (val.e), a small
// integer field, so the probe never itself expands the value. Only the length
// BEYOND this threshold is charged, so ordinary small-number math (val.e small)
// costs exactly what it did before. Charging is gated (host passes a null hook
// below the flag-day) so historical replay is unchanged.
const MATH_OUTPUT_GAS_THRESHOLD = 256;

// Safe upper bound on the fixed-notation string length of a bignumber, computed
// from its decimal exponent without materializing the string. |e| dominates: a
// magnitude of 10^e prints e+1 integer digits, and a magnitude of 10^-e prints
// ~|e| leading fractional zeros; the +70 covers the (<=64) significant digits
// plus sign / decimal point. Never under-estimates within that constant, so the
// charge cannot be dodged into a large-but-uncharged allocation.
function predictedFixedLength(val) {
    const e = (val && typeof val.e === 'number') ? val.e : 0;
    return Math.abs(e) + 70;
}

// Format a bignumber result as a fixed-notation string (no scientific notation)
function toFixed(val) {
    return mathjs.format(val, { notation: 'fixed' });
}

// The real/finite guard for the transcendental functions (sqrt/pow/log/...),
// which can legitimately produce complex ("1+2i") or non-finite ("Infinity")
// values that are footguns to return from a numeric contract API, lives inline
// in buildMathAPI's fmtReal so the output-size meter runs between the complex
// check and the fixed-notation expansion.

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
            // A gas-exhaustion from the output meter (below) is a resource fault,
            // NOT a contract revert: it must surface as out_of_gas (un-swallowable,
            // collapsed by the indexer), so re-throw it unwrapped rather than
            // masking it as a catchable 'math error' ContractRevertError.
            if (e instanceof GasExhaustedError) throw e;
            throw new ContractRevertError('math error: ' + e.message);
        }
    };
}

// outputGasHook: (units:number)=>void charged for the fixed-notation length a
// result BEYOND MATH_OUTPUT_GAS_THRESHOLD would materialize, or null to disable
// the charge (host passes null below the flag-day, preserving legacy replay).
function buildMathAPI(outputGasHook) {
    // Charge for an oversized result BEFORE its fixed-notation string is built,
    // so pow()'s host-side format() cannot allocate tens of MB for ~0 gas. Only
    // the excess over the threshold is charged, so ordinary math is unaffected.
    const chargeOutput = (val) => {
        if (outputGasHook && val && typeof val.e === 'number') {
            const excess = predictedFixedLength(val) - MATH_OUTPUT_GAS_THRESHOLD;
            if (excess > 0) outputGasHook(excess);   // may throw GasExhaustedError (sticky)
        }
        return val;
    };
    // Meter, then format as fixed notation.
    const fmt = (val) => toFixed(chargeOutput(val));
    // Real-valued variant: reject complex/non-finite (as toRealFixed does), but
    // meter the magnitude BEFORE the fixed-notation expansion so a huge pow()
    // result is priced before it is materialized.
    const fmtReal = (val) => {
        if (mathjs.isComplex(val))
            throw new Error('result is not a real number');
        chargeOutput(val);
        const s = toFixed(val);
        if (s === 'Infinity' || s === '-Infinity' || s === 'NaN')
            throw new Error('result is not a finite number');
        return s;
    };
    return {
        add:      safeMath((a, b) => fmt(add(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        subtract: safeMath((a, b) => fmt(subtract(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        multiply: safeMath((a, b) => fmt(multiply(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        divide:   safeMath((a, b) => fmt(safeDivide(a, b))),
        mod:      safeMath((a, b) => fmt(mod(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        compare:  safeMath((a, b) => cmp(a, b)),
        gt:       safeMath((a, b) => cmp(a, b) > 0),
        gte:      safeMath((a, b) => cmp(a, b) >= 0),
        lt:       safeMath((a, b) => cmp(a, b) < 0),
        lte:      safeMath((a, b) => cmp(a, b) <= 0),
        eq:       safeMath((a, b) => cmp(a, b) === 0),
        min:      safeMath((a, b) => { const ba = bignumber(validateInput(a)), bb = bignumber(validateInput(b)); return fmt(cmp(a, b) <= 0 ? ba : bb); }),
        max:      safeMath((a, b) => { const ba = bignumber(validateInput(a)), bb = bignumber(validateInput(b)); return fmt(cmp(a, b) >= 0 ? ba : bb); }),
        abs:      safeMath((a)    => fmt(bignumber(validateInput(a)).abs())),
        isZero:   safeMath((a)    => bignumber(validateInput(a)).isZero()),

        // Transcendental functions: deterministic, architecture-independent
        // replacements for the IEEE 754 Math.sqrt/pow/log/... that are no longer
        // exposed in the sandbox. mathjs bignumber is pure-software arithmetic,
        // so these produce bit-identical results on every CPU architecture. pow is
        // the one whose output magnitude is unbounded by the input cap, hence the
        // output meter above.
        sqrt:     safeMath((a)    => fmtReal(sqrt(bignumber(validateInput(a))))),
        pow:      safeMath((a, b) => fmtReal(pow(bignumber(validateInput(a)), bignumber(validateInput(b))))),
        log:      safeMath((a)    => fmtReal(log(bignumber(validateInput(a))))),
        log2:     safeMath((a)    => fmtReal(log2(bignumber(validateInput(a))))),
        log10:    safeMath((a)    => fmtReal(log10(bignumber(validateInput(a)))))
    };
}

module.exports = { buildMathAPI };
