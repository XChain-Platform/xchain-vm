// Non-recursive regex group-depth bound for the deploy lint pre-parse guard.
// @ts-nocheck

const acorn = require('acorn');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { MAX_REGEX_GROUP_DEPTH } = require('./constants.js');

// Acorn validates a regex body inside getToken(), by recursion with one call chain
// per group level, before the token reaches a scanner. RegexBoundParser measures the
// body first without recursion and stops before acorn validates an over-bound body.
class RegexGroupDepthExceeded extends Error {
    constructor(line, depth) {
        super('regex group depth ' + depth + ' at line ' + line);
        this.line = line;
        this.depth = depth;
    }
}

// A '(' opens a level unless it is escaped or inside a character class. Acorn finds
// the body's end with the same escape and class rules and recurses on no '(' this misses.
function regexGroupDepth(pattern) {
    let depth = 0;
    let max = 0;
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') i++;
        else if (inClass) inClass = ch !== ']';
        else if (ch === '[') inClass = true;
        else if (ch === '(') max = Math.max(max, ++depth);
        else if (ch === ')' && depth > 0) depth--;
    }
    return max;
}

const RegexBoundParser = acorn.Parser.extend((Parser) => class extends Parser {
    validateRegExpPattern(state) {
        const depth = regexGroupDepth(state.source);
        if (depth > MAX_REGEX_GROUP_DEPTH)
            throw new RegexGroupDepthExceeded(this.startLoc.line, depth);
        return super.validateRegExpPattern(state);
    }
});

/**
 * Build the historical tokenizer when the gate is off, or the bounded tokenizer
 * when it is on. The default stays on for author-facing lint-core callers.
 * @param {string} code
 * @param {boolean} [enforceRegexGroupDepth=true]
 */
function boundedTokenizer(code, enforceRegexGroupDepth) {
    const Parser = enforceRegexGroupDepth === false ? acorn.Parser : RegexBoundParser;
    return Parser.tokenizer(code, {
        ecmaVersion: CONTRACT_ECMA_VERSION,
        sourceType: 'script',
        locations: true
    });
}

function regexGroupDepthFindingAt(line) {
    return {
        rule: 'nesting-depth',
        message: 'regex group depth exceeds limit (' + MAX_REGEX_GROUP_DEPTH + ') at line ' + line,
        line: line,
        severity: 'error'
    };
}

/**
 * Run the bound on its own for callers whose syntax-depth scan is off.
 * @param {string} code
 */
function regexGroupDepthFinding(code) {
    if (typeof code !== 'string') return null;
    try {
        const tokenizer = boundedTokenizer(code, true);
        for (;;) {
            if (tokenizer.getToken().type === acorn.tokTypes.eof) break;
        }
    } catch (e) {
        if (e instanceof RegexGroupDepthExceeded) return regexGroupDepthFindingAt(e.line);
    }
    return null;
}

module.exports = {
    RegexGroupDepthExceeded,
    regexGroupDepth,
    boundedTokenizer,
    regexGroupDepthFindingAt,
    regexGroupDepthFinding
};
