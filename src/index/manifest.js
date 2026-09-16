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
 * XChain VM: manifest read
 *
 * The deploy-time permissions-manifest read: one execute() of the module
 * top level under the deploy block's own activation gates, returning the
 * raw typed report the indexer validates. XChainVM prototype method,
 * installed by the entry (../index.js).
 ********************************************************************/
// @ts-nocheck

module.exports = {
    /**
     * Read a contract's declared permissions manifest (Phase E) at deploy time.
     * Instantiates the module top-level inside an isolate (gas-metered, no state,
     * oracle, or balances) and surfaces its exported `permissions` + `maxTakeBps`
     * WITHOUT dispatching a method, deterministic across validators because it
     * depends only on the (immutable) contract code and the pinned runtime. Works
     * for constructor-less contracts, which vm.execute() never runs otherwise.
     *
     * Returns the raw, typed manifest report; the indexer (actions/deploy/index.js) owns
     * all validation + fail-closed rejection. On a module-level throw, success is
     * false and the host treats the contract as declaring no manifest (today's
     * behavior for a contract that only fails on its first execute).
     *
     * @param {string} code
     * @returns {Promise<{ success: boolean, manifest: object|null, error: string|null }>}
     */
    // The manifest read must resolve activation gates at the DEPLOY'S OWN block,
    // because its outcome is hashed into deploy status.
    //
    // An execute() with no block context resolves every gate PRE-ACTIVATION no
    // matter which block the deploy is in: `opts.network` and `opts.blockContext`
    // are undefined (so __pkg3Height is NaN and isPkg3SandboxActive false) and
    // __blockTime defaults to 0. The manifest would then be read under one sandbox
    // rule set while every later execute() of the same contract runs under another,
    // and any module-level code whose outcome differs across a gate (a guard that
    // only arms post-activation, or metering that only then charges toward the gas
    // ceiling) would produce a manifest, and therefore a DEPLOY VERDICT, computed
    // under rules not in force at that height.
    //
    // Callers pass the deploy's own context; omitting it preserves the old
    // pre-activation resolution for non-consensus callers (tooling, tests).
    async readManifest(code, opts) {
        opts = opts || {};
        const result = await this.execute({
            code, method: '__manifest__', readManifest: true,
            network:         opts.network,
            blockContext:    opts.blockContext,
            contractAddress: opts.contractAddress
        });
        if (!result.success)
            return { success: false, manifest: null, error: result.error };
        let manifest = null;
        try { manifest = JSON.parse(result.returnValue); } catch (e) { manifest = null; }
        return { success: true, manifest, error: null };
    },
};
