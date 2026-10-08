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
 * XChain VM: limits defaults
 *
 * Back-fills the resource limits a caller's limits object may omit.
 ********************************************************************/
// @ts-nocheck

const { MAX_CODE_SIZE, MAX_CALL_DEPTH, MIN_CALL_GAS, MAX_STACK_DEPTH } = require('../constants.js');

const DEFAULT_LIMITS = {
    maxCpuTimeMs:      30000,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxCodeSize:       MAX_CODE_SIZE,
    maxBlockCacheSize: 1000
};

function resolveLimits(limits) {
    const out = limits || { ...DEFAULT_LIMITS };
    // Cross-contract call limits: default the protocol constants when the
    // caller's limits object predates them (additive, non-breaking).
    if (!Number.isInteger(out.maxCallDepth))      out.maxCallDepth      = MAX_CALL_DEPTH;
    if (!Number.isInteger(out.minCallGas))        out.minCallGas        = MIN_CALL_GAS;
    // Intra-contract recursion bound (see MAX_STACK_DEPTH). Default the constant
    // when the caller's limits object predates it (additive, non-breaking).
    if (!Number.isInteger(out.maxStackDepth))     out.maxStackDepth     = MAX_STACK_DEPTH;
    // Core size caps (bac14514): a caller passing a PARTIAL limits object
    // leaves maxCodeSize === undefined, silently disabling the
    // execute-time code-size cap (and likewise the state caps, where
    // StateManager would compare against undefined). Back-fill the protocol
    // defaults exactly like the cross-contract limits above (additive,
    // behavior-preserving for callers that pass complete limits or none).
    if (!Number.isInteger(out.maxCodeSize))       out.maxCodeSize       = MAX_CODE_SIZE;
    if (!Number.isInteger(out.maxStateValueSize)) out.maxStateValueSize = 65536;
    if (!Number.isInteger(out.maxStateKeys))      out.maxStateKeys      = 10000;
    return out;
}

module.exports = { resolveLimits };
