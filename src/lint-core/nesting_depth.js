// Non-recursive delimiter-depth scanner for the deploy lint pre-parse guard.
// @ts-nocheck

const acorn = require('acorn');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');
const { MAX_NESTING_DEPTH } = require('./constants.js');

const OPEN_TOKENS = new Set(['(', '[', '{', '${']);
const CLOSE_TOKENS = new Set([')', ']', '}']);

/**
 * Find the first token whose delimiter depth exceeds the consensus limit.
 * Tokenization is iterative and ignores delimiter text in comments, strings,
 * regular expressions and template chunks.
 * @param {string} code
 * @param {number} [limit=MAX_NESTING_DEPTH]
 * @returns {Array<{line: number, depth: number}>}
 */
function findNestingDepth(code, limit) {
    if (typeof code !== 'string') return [];
    const maxDepth = limit === undefined ? MAX_NESTING_DEPTH : limit;
    const stack = [];
    let tokenizer;
    try {
        tokenizer = acorn.tokenizer(code, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script',
            locations: true
        });
        for (;;) {
            const token = tokenizer.getToken();
            const label = token.type.label;
            if (OPEN_TOKENS.has(label)) {
                stack.push(label);
                if (stack.length > maxDepth) {
                    return [{ line: token.loc.start.line, depth: stack.length }];
                }
            } else if (CLOSE_TOKENS.has(label) && stack.length > 0) {
                stack.pop();
            }
            if (label === 'eof') return [];
        }
    } catch (e) {
        return [];
    }
}

function nestingDepthFinding(code) {
    const hit = findNestingDepth(code)[0];
    if (!hit) return null;
    return {
        rule: 'nesting-depth',
        message: 'nesting depth exceeds limit (' + MAX_NESTING_DEPTH + ') at line ' + hit.line,
        line: hit.line,
        severity: 'error'
    };
}

module.exports = { findNestingDepth, nestingDepthFinding };
