/*********************************************************************
 * XChain VM — Deterministic Math
 *
 * Wraps mathjs bignumber for contract use. All inputs and outputs
 * are strings — no floating-point anywhere.
 ********************************************************************/

const { ContractRevertError } = require('./errors.js');
const mathjs = require('mathjs');
const { bignumber, add, subtract, multiply, divide, mod, compare } = mathjs;

// Maximum input length for math operations to prevent DoS via
// extreme-precision bignumber parsing (RISK-12, RISK-18).
const MAX_MATH_INPUT_LENGTH = 256;

// Format a bignumber result as a fixed-notation string (no scientific notation)
function toFixed(val) {
    return mathjs.format(val, { notation: 'fixed' });
}

// Validate math input length
function validateInput(val) {
    const s = String(val);
    if (s.length > MAX_MATH_INPUT_LENGTH)
        throw new Error('math input exceeds maximum length (' + MAX_MATH_INPUT_LENGTH + ' chars)');
    return s;
}

// Safely divide — mathjs returns Infinity for div by zero instead of throwing
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
        isZero:   safeMath((a)    => bignumber(validateInput(a)).isZero())
    };
}

module.exports = { buildMathAPI };
