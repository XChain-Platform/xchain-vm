// Banned-with scanner: the `with` statement, which rebinds free identifiers to an object at runtime.
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../metering.js');

/**
 * Scan contract code for `with` statements. A `with (obj) { ... }` block resolves
 * every free identifier inside it against `obj` first, so a name the static
 * scanners and the metering transform treat as a plain global or a reserved
 * helper can be rebound to an attacker-chosen property at runtime, defeating
 * the identifier-precise bans. The statement is only legal in sloppy-mode
 * scripts, which is exactly how contract code is compiled.
 *
 * @param {string} code - Contract source code
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
