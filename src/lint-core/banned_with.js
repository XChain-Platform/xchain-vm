// Banned-with scanner: the `with` statement, which rebinds free identifiers to an object at runtime.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');

/**
 * Find `with` statements that can bypass identifier-based rules.
 * @param {string} code
 * @returns {Array<{line: (number|string)}>}
 */
function findBannedWith(code) {
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        WithStatement(node) {
            hits.push({ line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

module.exports = { findBannedWith };
