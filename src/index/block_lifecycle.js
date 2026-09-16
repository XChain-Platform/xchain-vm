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
 * XChain VM: block lifecycle
 *
 * The per-block compilation-cache boundaries and the executor teardown,
 * each delegated to the subprocess executor when one is configured.
 * XChainVM prototype methods, installed by the entry (../index.js).
 ********************************************************************/
// @ts-nocheck

module.exports = {
    /**
     * Called at the start of each block to initialize the compilation cache.
     */
    beginBlock() {
        if (this._executor) return this._executor.beginBlock();
        this._blockCache = new Map();
    },

    /**
     * Called at the end of each block to clear the compilation cache.
     */
    endBlock() {
        if (this._executor) return this._executor.endBlock();
        this._blockCache = null;
    },

    /**
     * Tear down the subprocess executor (kills the worker child). No-op in
     * in-process mode. Call from long-lived hosts on shutdown and from tests.
     */
    async shutdown() {
        if (this._executor) return this._executor.shutdown();
    },
};
