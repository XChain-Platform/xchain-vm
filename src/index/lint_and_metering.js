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
 * XChain VM: source lint and metering
 *
 * The two source-keyed caches (metered code, execute-time lint verdict)
 * and the deploy-time syntax and float-warning wrappers. Both caches are
 * invisible to consensus: a hit returns exactly what a fresh call would.
 * XChainVM prototype methods, installed by the entry (../index.js).
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');

const { meterCode }     = require('../metering.js');
const { validateSyntax, checkFloatWarnings } = require('../syntax.js');

module.exports = {
    /**
     * Return the gas-metered form of `code`, from the metered-source cache when
     * possible. meterCode() is a pure AST transform (acorn parse + AST walk +
     * astring regen over up to maxCodeSize bytes), the single most expensive step
     * of a warm execute, and its output depends ONLY on `code` and the two
     * consensus gate flags, all folded into the cache key. A hit therefore returns
     * byte-identical metered source to a fresh meterCode() call, so the cache is
     * invisible to consensus (same key -> same transform) and only removes
     * redundant per-execute parsing.
     *
     * The key hashes the source with sha256 so a 64KB body is compared in 32 bytes
     * and appends the three gate bits (evalOrder, callSpread, restPattern). The cache persists
     * across blocks (unlike _blockCache, the V8 cachedData store cleared by
     * endBlock): a contract re-executing block after block re-meters at most once
     * per (source, gate-flags) pair. Bounded by maxMeteredCacheSize with FIFO
     * eviction; correctness holds when it is empty.
     *
     * A metering failure (invalid source) is propagated by throwing and is NOT
     * cached: the miss path stays simple and the cache holds only valid output.
     * @param {string} code
     * @param {boolean} specEvalOrder
     * @param {boolean} meterCallSpread
     * @param {boolean} meterRestPattern
     * @param {string} [codeHash] - precomputed sha256(code) hex. Optional: execute()
     *        computes the digest once and shares it with the lint-verdict cache
     *        so a 64KB body is hashed once per execution, not twice.
     *        Omitting it recomputes the identical digest, so the key is unchanged.
     * @returns {string} metered source
     */
    getMeteredCode(code, specEvalOrder, meterCallSpread, meterRestPattern, codeHash) {
        const key = (codeHash || crypto.createHash('sha256').update(code).digest('hex')) +
            ':' + (specEvalOrder ? '1' : '0') + (meterCallSpread ? '1' : '0') +
            (meterRestPattern ? '1' : '0');
        const hit = this._meteredCache.get(key);
        if (hit !== undefined) return hit;
        const metered = meterCode(code, {
            specEvalOrder: specEvalOrder,
            meterCallSpread: meterCallSpread,
            meterRestPattern: meterRestPattern
        });
        // FIFO-evict the oldest entry at capacity (Map preserves insertion order).
        // This cache never feeds consensus, so the eviction policy is a pure
        // memory/hit-rate tradeoff, not a determinism concern.
        if (this._meteredCache.size >= this.limits.maxMeteredCacheSize) {
            const oldest = this._meteredCache.keys().next().value;
            if (oldest !== undefined) this._meteredCache.delete(oldest);
        }
        this._meteredCache.set(key, metered);
        return metered;
    },

    /**
     * Return the execute-time consensus source-lint verdict for `code` under the
     * resolved ban flags, from the verdict cache when possible.
     *
     * validateSyntax() is a pure function of (code, enforceBannedAsync,
     * enforceLintHardening, enforceBannedGenerator === enforceBannedWasm,
     * enforceLintGlobalAlias), all folded into the key, so a hit returns the verdict a
     * fresh call would produce. The two Pkg 3 rules share ONE activation and are
     * therefore threaded as one bit; the global-alias refinement rides its own.
     *
     * This exists because validateSyntax spawns an ivm.Isolate for its V8 syntax check
     * and then acorn-parses the source; paying that on every execute of a hot contract
     * would put an isolate spawn on the execution path. The CALLER charges the lint gas
     * unconditionally, before consulting this cache, so cache state can never move
     * gasUsed. Bounded by maxMeteredCacheSize with FIFO eviction (a pure memory/hit-rate
     * tradeoff, not a determinism concern); correctness holds when it is empty.
     *
     * @param {string} code
     * @param {boolean} enforceBannedAsync
     * @param {boolean} enforceLintHardening
     * @param {boolean} enforcePkg3Bans - banned-generator + banned-wasm (one gate)
     * @param {boolean} enforceLintGlobalAlias - LINT_GLOBAL_ALIAS refinement (own gate)
     * @param {boolean} enforceBannedRest - banned-rest (REST_PATTERN_METER, own gate)
     * @param {string} [codeHash] - precomputed sha256(code) hex (see getMeteredCode)
     * @returns {{valid: boolean, error?: string}}
     */
    getLintVerdict(code, enforceBannedAsync, enforceLintHardening, enforcePkg3Bans, enforceLintGlobalAlias, enforceBannedRest, codeHash) {
        const key = (codeHash || crypto.createHash('sha256').update(code).digest('hex')) +
            ':' + (enforceBannedAsync ? '1' : '0') +
            (enforceLintHardening ? '1' : '0') +
            (enforcePkg3Bans ? '1' : '0') +
            (enforceLintGlobalAlias ? '1' : '0') +
            (enforceBannedRest ? '1' : '0');
        const hit = this._lintVerdictCache.get(key);
        if (hit !== undefined) return hit;
        const verdict = validateSyntax(code, {
            enforceBannedAsync:      enforceBannedAsync,
            enforceLintHardening:    enforceLintHardening,
            enforceBannedGenerator:  enforcePkg3Bans,
            enforceBannedWasm:       enforcePkg3Bans,
            enforceLintGlobalAlias:  enforceLintGlobalAlias,
            enforceBannedRest:       enforceBannedRest
        });
        if (this._lintVerdictCache.size >= this.limits.maxMeteredCacheSize) {
            const oldest = this._lintVerdictCache.keys().next().value;
            if (oldest !== undefined) this._lintVerdictCache.delete(oldest);
        }
        this._lintVerdictCache.set(key, verdict);
        return verdict;
    },

    /**
     * Validate contract code syntax before deployment.
     * @param {string} code
     * @param {object} [opts]
     * @param {boolean} [opts.enforceBannedAsync=true] - block async/await/Promise
     *        (CONSENSUS_RULES 'banned-async'). CONSENSUS-GATED on the indexer:
     *        deploy/index.js passes the resolved VM_BANNED_ASYNC activation so a
     *        from-genesis replay reproduces the historical accept-below verdict.
     *        Defaults to true for author-facing callers (SDK linter, unit tests).
     * @returns {{ valid: boolean, error?: string }}
     */
    validateSyntax(code, opts) {
        return validateSyntax(code, opts);
    },

    /**
     * Check for floating-point usage warnings.
     * @param {string} code
     * @returns {string[]}
     */
    checkFloatWarnings(code) {
        return checkFloatWarnings(code);
    },
};
