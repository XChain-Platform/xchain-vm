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
 * XChain VM Toolkit: warnings for the height-gated BigInt surface strip
 *
 * Once the BigInt surface strip is active the sandbox deletes the 64-bit
 * BigInt typed arrays and neuters the DataView BigInt accessors, so a contract
 * using them lints clean, deploys, and throws on its first execution. These
 * findings are warnings only: no deploy verdict depends on them.
 ********************************************************************/
// @ts-nocheck

const acorn = require('acorn');
const walk = require('acorn-walk');
const { CONTRACT_ECMA_VERSION } = require('../../metering.js');
const { findBannedStrippedGlobals } = require('../../lint-core.js');
const {
    GATED_STRIPPED_GLOBALS_TAUGHT,
    GATED_STRIPPED_PROTO_METHODS_TAUGHT
} = require('../authoring/authoring_knowledge.js');

const RULE = 'gated-stripped-global';

function warning(name, line) {
    return {
        rule: RULE,
        message: 'gated stripped name: ' + name + ' at line ' + line +
                 '; the sandbox deletes it on regtest and past its activation height, ' +
                 'so this throws at runtime there. Use xchain.math.* instead',
        line: typeof line === 'number' ? line : null,
        severity: 'warning'
    };
}

// Member accesses naming a DataView BigInt accessor, by identifier or string key.
// The receiver type is not resolved, so an unrelated object with the same method
// name also warns; that costs a false line, never a verdict.
function findGatedProtoMethods(code) {
    const wanted = new Set(GATED_STRIPPED_PROTO_METHODS_TAUGHT);
    const hits = [];
    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: true });
    } catch (e) {
        return hits;
    }
    walk.simple(ast, {
        MemberExpression(node) {
            const p = node.property;
            const key = !node.computed && p.type === 'Identifier' ? p.name
                : (node.computed && p.type === 'Literal' && typeof p.value === 'string' ? p.value : null);
            if (key && wanted.has(key)) hits.push({ name: key, line: node.loc ? node.loc.start.line : '?' });
        }
    });
    return hits;
}

/**
 * Collect the gated-strip warnings for one contract source.
 * @param {string} code - contract source
 * @returns {Array<{rule:string,message:string,line:(number|null),severity:string}>}
 */
function gatedStripWarnings(code) {
    const out = [];
    try {
        for (const hit of findBannedStrippedGlobals(code, true, GATED_STRIPPED_GLOBALS_TAUGHT, true))
            out.push(warning(hit.name, hit.line));
        for (const hit of findGatedProtoMethods(code)) out.push(warning(hit.name, hit.line));
    } catch (e) { /* unparseable; the lint errors already report it */ }
    return out;
}

module.exports = { gatedStripWarnings, GATED_STRIP_RULE: RULE };
