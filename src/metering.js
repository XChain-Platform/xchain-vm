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
 * XChain VM: AST-Based Gas Metering
 *
 * Transforms contract source code by injecting __gas(1) calls at
 * control flow points. This enables deterministic gas metering
 * without modifying V8 internals.
 *
 * Uses acorn to parse, modifies the AST in place, then regenerates
 * source via astring. This avoids fragile string offset splicing.
 ********************************************************************/
// @ts-nocheck

const acorn = require('acorn');
const { generate } = require('astring');
const { CONTRACT_ECMA_VERSION, RESERVED_IDENTIFIERS, findReservedIdentifier, hasGasIdentifier } = require('./metering/reserved_identifiers.js');
const { insertGasAfterDirectives } = require('./metering/ast_builders.js');
const { transformAllocators } = require('./metering/allocator_transform.js');
const {
    injectBlockGas, injectBinaryDepthGas, injectCallGas, injectDepthGuards
} = require('./metering/visitor_instrumentation.js');

/**
 * Transform contract source code by injecting gas metering calls.
 * @param {string} source - Original contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.specEvalOrder] - L-3 consensus gate. When true, obj[k] += rhs
 *   is rewritten to the spec-correct order (read obj[k] before evaluating rhs) via
 *   __setconcatL; when false/omitted the historical __setconcat form is preserved
 *   byte-for-byte. index.js resolves this from the block time so pre-gate blocks
 *   replay identically. Consensus-visible: a divergent value forks the fleet.
 * @param {boolean} [opts.meterCallSpread] - consensus gate. When true, call/new/method
 *   argument spread (f(...x), new C(...x), arr.push(...x)) is rebuilt through the
 *   size-charged __arrspread helper so the O(n) element copy is metered; when
 *   false/omitted the call is emitted verbatim (legacy flat __gas(1)). index.js
 *   resolves this from the block time so pre-gate blocks replay identically.
 * @param {boolean} [opts.meterRestPattern] - consensus gate. When true, the SOURCE of a
 *   destructuring rest with an addressable source (`var [x, ...c] = a`,
 *   `var {k, ...c} = o`, and the assignment-expression forms) is wrapped in
 *   __arrspread / __objspreadmeter so the O(n) copy is metered; when false/omitted the
 *   destructure is emitted verbatim (legacy flat __gas(1)). index.js resolves this from
 *   the block time so pre-gate blocks replay identically.
 * @returns {string} Transformed source with __gas(1) calls injected
 */
function meterCode(source, opts) {
    const specEvalOrder = !!(opts && opts.specEvalOrder);
    const meterCallSpread = !!(opts && opts.meterCallSpread);
    const meterRestPattern = !!(opts && opts.meterRestPattern);
    const ast = acorn.parse(source, {
        ecmaVersion: CONTRACT_ECMA_VERSION,
        sourceType: 'script',
        locations: true
    });

    // Phase 0: rewrite syntax-level allocators (string +/+=, template literals,
    // array/object spread, and gated call/new argument spread) into metered helper
    // calls, on the pristine AST before any __gas() insertion. The helper calls are
    // exempted from Phase 3 below.
    transformAllocators(ast, specEvalOrder, meterCallSpread, meterRestPattern);

    // Track nodes we've already processed to avoid double-injection
    const processed = new WeakSet();

    // Charge gas at the top-level script entry point. The metered source runs
    // as a function body (new __Fn(..., meteredCode)), so top-level statements
    // (variable declarations, object-literal initializers, plain assignments)
    // would otherwise execute uncharged unless they happen to contain a call.
    // Inject after any directive prologue, exactly as function bodies are handled.
    insertGasAfterDirectives(ast.body);

    injectBlockGas(ast, processed);
    injectBinaryDepthGas(ast, processed);
    injectCallGas(ast, processed);
    injectDepthGuards(ast);

    return generate(ast);
}

module.exports = { meterCode, hasGasIdentifier, findReservedIdentifier, RESERVED_IDENTIFIERS, CONTRACT_ECMA_VERSION };
