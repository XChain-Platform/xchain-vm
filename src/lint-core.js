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
 * XChain VM: Contract Lint Core (dependency-light, no isolated-vm)
 *
 * The canonical, acorn-only contract validation rules. Every deploy-time
 * check EXCEPT the V8 syntax compile (step 1), which needs isolated-vm and
 * stays in syntax.js. Depends only on acorn / acorn-walk / astring (via
 * metering.js), so it is safe to run in a browser / any-Node context.
 *
 * THIS FILE IS A SHARED SOURCE OF TRUTH. xchain-sdk vendors a byte-identical
 * copy at src/contract/lint-core.js; a CI parity guard (sha256) fails the
 * build on drift. Edit here, then re-sync the vendored copy.
 *
 * lintSource(code) -> { errors: Rule[], warnings: Rule[] }
 *   where Rule = { rule: string, message: string, line: number|null }
 *
 * Message strings are BYTE-IDENTICAL to what syntax.js historically emitted.
 * validateSyntax returns errors[0].message verbatim, and checkFloatWarnings
 * returns warnings.map(w => w.message), so the deploy-path verdict (recorded
 * in on-chain execution records) is unchanged.
 ********************************************************************/
// @ts-nocheck

// @ts-nocheck

const constants = require('./lint_core/constants.js');
const { STRIPPED_GLOBAL_NAMES, ADVISORY_STRIPPED_GLOBAL_NAMES } = require('./stripped-globals.js');
const { CONTRACT_ECMA_VERSION } = require('./metering.js');
const banned_syntax = require('./lint_core/banned_syntax.js');
const banned_globals = require('./lint_core/banned_globals.js');
const { analyzeContract } = require('./lint_core/contract_analysis.js');
const { lintSource } = require('./lint_core/result_composition.js');

module.exports = {
    lintSource,
    analyzeContract,
    findBannedMathCalls: banned_syntax.findBannedMathCalls,
    findBannedLiterals: banned_syntax.findBannedLiterals,
    findBannedAsync: banned_globals.findBannedAsync,
    findBannedGenerator: banned_globals.findBannedGenerator,
    findBannedWasm: banned_globals.findBannedWasm,
    findBannedRest: banned_syntax.findBannedRest,
    findBannedExponentiation: banned_syntax.findBannedExponentiation,
    findBannedProtoMethods: banned_syntax.findBannedProtoMethods,
    findBannedStrippedGlobals: banned_globals.findBannedStrippedGlobals,
    findReservedControlBinding: banned_syntax.findReservedControlBinding,
    codeSizeBytes: banned_syntax.codeSizeBytes,
    MAX_CODE_SIZE: constants.MAX_CODE_SIZE,
    STRIPPED_PROTO_METHOD_NAMES: constants.STRIPPED_PROTO_METHOD_NAMES,
    STRIPPED_GLOBAL_NAMES,
    STRIPPED_GLOBAL_NAMES_MIRROR: STRIPPED_GLOBAL_NAMES,
    ADVISORY_STRIPPED_GLOBALS: ADVISORY_STRIPPED_GLOBAL_NAMES,
    findFloatWarnings: banned_syntax.findFloatWarnings,
    CONSENSUS_RULES: constants.CONSENSUS_RULES,
    CONTRACT_ECMA_VERSION,
    SAFE_MATH_MEMBERS: constants.SAFE_MATH_MEMBERS,
    RESERVED_CONTROL_BINDINGS: constants.RESERVED_CONTROL_BINDINGS
};
