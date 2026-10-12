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
 * XChain VM: metering reserved identifiers and contract language version
 ********************************************************************/
// @ts-nocheck

const acorn = require('acorn');
const walk  = require('acorn-walk');

// The contract language version: a FROZEN consensus choice, not an acorn
// default. Every parse in the VM (metering transform, reserved-identifier
// scan, deploy-time validation and the lint scans in syntax.js) pins to this
// version. V8 on the pinned Node runtime accepts a superset of ES2020, so
// everything acorn accepts here parses identically at execution time; the
// only effect of the gap is that post-2020 syntax is rejected at DEPLOY with
// a parse error (a DX limitation, never a consensus divergence). Bumping
// this is a deliberate protocol migration: the metering transform must be
// re-verified against every AST node type the new version introduces
// (e.g. class static blocks), and contracts deployed before the bump must
// keep validating. Do not change it casually.
const CONTRACT_ECMA_VERSION = 2020;

// Harness-injected helpers (src/index.js) that meter syntax-level allocators.
// The pass below rewrites operators/syntax into calls to these; they must never
// be wrapped as ordinary call sites, and contract source may not reference them.
const ALLOC_HELPERS = ['__concat', '__setconcat', '__setconcatL', '__tmpl', '__tmpltag', '__tmpltagm', '__arrspread', '__objspread', '__objspreadmeter'];
// Deterministic call-depth metering helpers (src/index.js harness). Phase 4 below
// wraps every contract function body in __depth_enter()/finally __depth_exit() so
// intra-contract recursion is bounded by a fixed, platform-independent depth (not
// by V8's architecture-dependent native stack limit). Reserved like __gas: a
// contract may not define or reference them.
const DEPTH_HELPERS = ['__depth_enter', '__depth_exit'];
const RESERVED_IDENTIFIERS = ['__gas'].concat(ALLOC_HELPERS).concat(DEPTH_HELPERS);
const HELPER_SET = new Set(ALLOC_HELPERS);

/**
 * Find the first reserved identifier used in the source, if any. Reserved names
 * are the harness-injected metering hooks (__gas + the allocator helpers); a
 * contract may not define or reference them or it could bypass/forge metering.
 * @param {string} source - Contract source code
 * @returns {string|null} the offending reserved name, or null if none
 */
function findReservedIdentifier(source) {
    try {
        const ast = acorn.parse(source, {
            ecmaVersion: CONTRACT_ECMA_VERSION,
            sourceType: 'script'
        });
        let found = null;
        // walk.full visits every node in the AST including nested Identifiers
        walk.full(ast, (node) => {
            if (!found && node.type === 'Identifier' && RESERVED_IDENTIFIERS.indexOf(node.name) !== -1) {
                found = node.name;
            }
        });
        return found;
    } catch (e) {
        // If parsing fails, let validateSyntax handle it
        return null;
    }
}

// Back-compat boolean form (the __gas-only check callers may still use).
function hasGasIdentifier(source) { return findReservedIdentifier(source) !== null; }

module.exports = { CONTRACT_ECMA_VERSION, ALLOC_HELPERS, DEPTH_HELPERS, RESERVED_IDENTIFIERS, HELPER_SET, findReservedIdentifier, hasGasIdentifier };
