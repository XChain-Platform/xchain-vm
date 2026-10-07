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
 * XChain VM: instance caches
 *
 * The per-instance caches and the harness source an XChainVM carries.
 ********************************************************************/
// @ts-nocheck

const { HARNESS_SOURCE } = require('./harness_source.js');

function initCaches(vm) {
    // Per-block compilation cache: Map<contractIndex:sha256(fullSource), cachedData>.
    // Keyed on the FULL compiled source (metered body + method + flags), not just
    // the contract code, so a same-code/same-index execute under a different method
    // is a cache MISS rather than a byte-length-collision hit (see execute()).
    vm._blockCache = null;

    // Metered-source cache:
    //   Map<sha256(code):evalOrderBit+callSpreadBit+restPatternBit, meteredCode>.
    // meterCode() is a pure AST transform (acorn parse + walk + astring regen over
    // up to maxCodeSize bytes), the single most expensive step of a warm execute,
    // and its output depends ONLY on the contract source plus the consensus
    // gate flags (specEvalOrder, meterCallSpread, meterRestPattern), all baked into
    // the key. So a
    // hit returns byte-identical metered source to a fresh call: no consensus
    // effect, only a parse-time speedup. Unlike _blockCache (V8 cachedData, which
    // is per-block and cleared by endBlock), this cache persists ACROSS blocks:
    // the same contract re-executing block after block re-meters at most once per
    // (code, gate-flags) combination, not once per execute. Bounded by
    // maxMeteredCacheSize with FIFO eviction; correctness holds if it is empty.
    vm._meteredCache = new Map();
    // Default the cache bound when the caller's limits object predates it.
    if (!Number.isInteger(vm.limits.maxMeteredCacheSize))
        vm.limits.maxMeteredCacheSize = vm.limits.maxBlockCacheSize || 1000;

    // Execute-time lint-verdict cache:
    //   Map<sha256(code):<one bit per flag parameter of getLintVerdict>, {valid, error?}>.
    // INVARIANT: the key carries the code digest plus EVERY consensus flag the
    // verdict depends on, with no count written down here that a new flag can
    // falsify. Adding a flag to getLintVerdict without adding its bit lets a warm
    // node answer from a verdict computed under the other setting, which is the one
    // way this cache can reach consensus.
    // Shares the metering cache's sha256(code) key material (the digest is computed
    // ONCE per execution and handed to both lookups). validateSyntax is a pure
    // function of exactly those inputs, so a hit returns the identical verdict a
    // fresh call would: the cache is invisible to consensus and only removes the
    // repeated ivm.Isolate spawn + acorn parse that the check would otherwise pay
    // on every execute of the same contract. Its GAS is charged unconditionally
    // (hit or miss), so a cold and a warm node bill the same. Bounded by
    // maxMeteredCacheSize with FIFO eviction, exactly like _meteredCache;
    // correctness holds when it is empty.
    vm._lintVerdictCache = new Map();

    // Pre-compile the harness script source (it's the same every time)
    vm._harnessSource = HARNESS_SOURCE;
    // Lazily-populated V8 cached data for the harness. The harness source
    // is the same constant string on every execution; per-execution inputs
    // (__blockTime, __BINARY_ALLOC_GATE_BLOCK_TIME) are injected as context
    // globals BEFORE the script runs, not baked into the source, so the
    // compiled bytecode is identical across calls. Storing cachedData here
    // and passing it to compileScriptSync avoids re-parsing the harness on
    // every contract execution, mirroring the per-block contract cache.
    vm._harnessCachedData = null;
}

module.exports = { initCaches };
