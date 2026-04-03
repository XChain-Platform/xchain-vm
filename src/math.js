/*********************************************************************
 * XChain VM — Deterministic Math
 *
 * Wraps mathjs bignumber for contract use. All inputs and outputs
 * are strings — no floating-point anywhere.
 ********************************************************************/

const { ContractRevertError } = require('./errors.js');
const mathjs = require('mathjs');
const { bignumber, add, subtract, multiply, divide, mod, compare } = mathjs;

// Format a bignumber result as a fixed-notation string (no scientific notation)
function toFixed(val) {
    return mathjs.format(val, { notation: 'fixed' });
}

// Safely divide — mathjs returns Infinity for div by zero instead of throwing
function safeDivide(a, b) {
    const bb = bignumber(b);
    if (bb.isZero()) throw new Error('Division by zero');
    return divide(bignumber(a), bb);
}

// Compare and return a plain number (-1, 0, 1)
function cmp(a, b) {
    return Number(compare(bignumber(a), bignumber(b)));
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
        add:      safeMath((a, b) => toFixed(add(bignumber(a), bignumber(b)))),
        subtract: safeMath((a, b) => toFixed(subtract(bignumber(a), bignumber(b)))),
        multiply: safeMath((a, b) => toFixed(multiply(bignumber(a), bignumber(b)))),
        divide:   safeMath((a, b) => toFixed(safeDivide(a, b))),
        mod:      safeMath((a, b) => toFixed(mod(bignumber(a), bignumber(b)))),
        compare:  safeMath((a, b) => cmp(a, b)),
        gt:       safeMath((a, b) => cmp(a, b) > 0),
        gte:      safeMath((a, b) => cmp(a, b) >= 0),
        lt:       safeMath((a, b) => cmp(a, b) < 0),
        lte:      safeMath((a, b) => cmp(a, b) <= 0),
        eq:       safeMath((a, b) => cmp(a, b) === 0),
        min:      safeMath((a, b) => { const ba = bignumber(a), bb = bignumber(b); return toFixed(cmp(a, b) <= 0 ? ba : bb); }),
        max:      safeMath((a, b) => { const ba = bignumber(a), bb = bignumber(b); return toFixed(cmp(a, b) >= 0 ? ba : bb); }),
        abs:      safeMath((a)    => toFixed(bignumber(a).abs())),
        isZero:   safeMath((a)    => bignumber(a).isZero())
    };
}

module.exports = { buildMathAPI };
