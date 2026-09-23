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
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('../../index.js');
const { HEIGHT_GATES, GENESIS_ACTIVE_NETWORKS } = require('./constants.js');
const { heightGateThreshold, defaultBlockHeight } = require('./block_time_gates.js');
const {
    isContractMetaRequiredActive,
    manifestPolicyError,
    contractMetaError
} = require('./manifest_gate.js');

module.exports = {
    // ---- block control ------------------------------------------------------

    /**
     * Warn once per simulator when the simulated block time sits below the VM's
     * newest metering flag-day. Every block-time-keyed meter is OFF down there,
     * so the gasUsed this run reports is a pre-activation number no live chain
     * charges. Deliberate below-gate runs are legitimate (the VM's own gated
     * fixtures do exactly that), so this warns rather than throwing.
     *
     * Measured against THIS instance's live anchor, not against the newest ratified
     * gate. A future-dated flag day is not a rule any chain runs, so a caller who
     * simulates a real present-day mainnet timestamp is not behind anything and gets
     * no warning; against the max anchor that caller was told it predated a flag-day
     * it had in fact already passed.
     */
    warnIfPreGate() {
        if (this._preGateWarned) return;
        const live = this._liveBlockTime;
        if (Number(this.block.timestamp) >= live) return;
        this._preGateWarned = true;
        console.warn(
            '[xchain-vm simulator] block.timestamp ' + this.block.timestamp + ' predates the VM ' +
            'metering flag-day ' + live + ': the block-time-keyed gas meters are OFF, ' +
            'so gasUsed UNDER-REPORTS what a live chain charges. Use the default block, ' +
            'setBlock({ timestamp: ' + live + ' }) or advanceBlock({ byTime }) to ' +
            'simulate the live rule set.'
        );
    },

    /**
     * Warn once per simulator when a height-keyed gate is OFF for the contract being
     * executed. The derived default clears every armed gate for the CONFIGURED coin,
     * so this fires only where the default cannot help: an author-pinned height below
     * a threshold, or a contractAddress that is not `C:<COIN>:<idx>` (an unresolvable
     * coin resolves every one of these gates to inactive whatever the height).
     *
     * The gate decision itself is delegated to the VM's exported predicates, so the
     * toolkit can never drift from index.js; the map is read only to tell an ARMED
     * gate from the explicit `null` unarmed sentinel, which must never warn.
     * Deliberate below-gate runs stay legal, so this warns rather than throwing.
     */
    warnIfPreHeightGate(contractAddress) {
        if (this._preHeightGateWarned) return;
        if (GENESIS_ACTIVE_NETWORKS.indexOf(this.network) !== -1) return;

        const coin = XChainVM.pkg3CoinFromAddress(contractAddress);
        const height = Number(this.block.height);
        const armed = HEIGHT_GATES.filter(
            (g) => heightGateThreshold(g, coin, this.network) !== undefined);

        if (!armed.length) {
            this._preHeightGateWarned = true;
            console.warn(
                '[xchain-vm simulator] no block-HEIGHT activation is armed for coin ' +
                JSON.stringify(coin) + ' on network ' + JSON.stringify(this.network) + ' ' +
                '(resolved from contract address ' + JSON.stringify(contractAddress) + '): the ' +
                'Pkg-3 sandbox, the execute-time re-lint and the lint global-alias refinement ' +
                'all resolve to INACTIVE at every height, so this run does NOT reproduce a ' +
                'mainnet rule set. Deploy at a C:<COIN>:<idx> address whose coin the VM gates.'
            );
            return;
        }

        const off = armed.filter((g) => !XChainVM[g.isActive](this.network, coin, height));
        if (!off.length) return;
        this._preHeightGateWarned = true;
        console.warn(
            '[xchain-vm simulator] block.height ' + height + ' is below the ' + this.network +
            ' activation for ' + coin + ': ' +
            off.map((g) => g.label + ' (' + heightGateThreshold(g, coin, this.network) + ')').join(', ') +
            ' ' + (off.length === 1 ? 'is' : 'are') + ' OFF, so this run executes a ' +
            'PRE-activation rule set the live chain has left behind. Use the default block or ' +
            'setBlock({ height: ' + defaultBlockHeight(coin, this.network) + ' }).'
        );
    },

    /**
     * Warn once per simulator when a seeded balance sits outside the two addresses
     * a node's snapshot carries. xchain-indexer builds the getBalance snapshot for
     * the action's SOURCE and the contract's own address only (run_vm.js, and the
     * constructor and controller-guard paths alike), so any other seeded address
     * reads a value here and null on chain. Advisory: a suite that seeds several
     * callers is legitimate, and the seed is left in place.
     */
    warnIfBalanceOutOfScope(caller, contractAddress) {
        if (this._balanceScopeWarned) return;
        const outside = Object.keys(this.balances)
            .filter((a) => a !== caller && a !== contractAddress);
        if (!outside.length) return;
        this._balanceScopeWarned = true;
        console.warn(
            '[xchain-vm simulator] balances are seeded for ' + JSON.stringify(outside) +
            ', outside this call\'s snapshot scope (caller ' + JSON.stringify(caller) +
            ', contract ' + JSON.stringify(contractAddress) + '). A node preloads only ' +
            'those two addresses, so a contract reading getBalance for any other one ' +
            'gets null on chain whatever it reads here.'
        );
    },

    /**
     * Run the first two legs of the chain's DEPLOY gate (size cap, validateSyntax)
     * over already-transpiled source and return their verdict as `{ valid, error }`;
     * manifestGateVerdict is the third leg. ADVISORY: deploy() reports it and warns once,
     * it never refuses, because simulating a source the chain would reject is a
     * legitimate move (this repo's own fixtures deploy a WebAssembly probe to
     * measure the runtime strip) and a public toolkit API that started throwing
     * would break those callers silently.
     *
     * The gate is the indexer's, resolved at THIS simulator's epoch rather than
     * hardcoded on: xchain-indexer/src/actions/deploy/index.js checks the UTF-8 size cap
     * and then calls vm.validateSyntax with six epoch-resolved ban flags. It reads
     * those flags from its own protocolChanges table and per-coin activation
     * modules; the VM's exported predicates are the twins index.js already uses for
     * the execute-time re-lint (see the flag map above isExecLintActive's caller),
     * so they resolve the same verdict without a second copy of the thresholds.
     * The two height-keyed flags take the CONFIGURED coin, matching deploy/index.js,
     * which reads its node's COIN rather than deriving one from the address.
     *
     * banned-rest is the sixth and rides the REST_PATTERN_METER block-time flag-day,
     * so it resolves from isRestPatternMeterActive exactly as the execute-time
     * re-lint does. Omitting the key is not neutral: syntax.js defaults every
     * enforce* flag to ON, so a missing flag enforces a rule the chain has not
     * activated and rejects a source a pre-flag-day mainnet block accepts.
     */
    deployGateVerdict(src) {
        if (Buffer.byteLength(src, 'utf8') > this.limits.maxCodeSize)
            return { valid: false, error: 'exceeds max size' };
        const time   = Number(this.block.timestamp);
        const height = Number(this.block.height);
        const pkg3   = XChainVM.isPkg3SandboxActive(this.network, this.coin, height);
        try {
            return this.vm.validateSyntax(src, {
                enforceBannedAsync:     XChainVM.isAsyncSurfaceActive(this.network, time),
                enforceLintHardening:   XChainVM.isLintHardeningActive(this.network, time),
                enforceBannedGenerator: pkg3,
                enforceBannedWasm:      pkg3,
                enforceLintGlobalAlias: XChainVM.isLintGlobalAliasActive(this.network, this.coin, height),
                enforceBannedRest:      XChainVM.isRestPatternMeterActive(this.network, time)
            });
        } catch (e) {
            // The V8 leg of validateSyntax spawns an isolate, and a spawn failure is a
            // property of THIS machine, not of the contract (syntax.js raises
            // HostFaultError for exactly that split). Reporting `valid: true` there
            // would hand the author the reassuring answer a real pass gives, so the
            // verdict is neither: null says the gate did not run.
            return { valid: null, error: 'deploy gate could not run on this host: ' + e.message };
        }
    },

    /**
     * Run the third leg of the chain's DEPLOY gate: read the contract's manifest the
     * way xchain-indexer/src/actions/deploy/manifest.js does (same call, same block
     * context, the real contract address the sandbox gate derives its coin from),
     * then judge the policy rows and, once CONTRACT_META_REQUIRED is armed at this
     * block, the meta ladder. A module top level that throws is a real reject (the
     * chain records `manifest read failed`), so only a read that throws, a host
     * fault rather than a verdict, returns the null "gate did not run" verdict.
     * @param {string} src - transpiled source that already passed the first two legs
     * @param {string} contractAddress
     * @returns {Promise<{valid: (boolean|null), error?: string}>}
     */
    async manifestGateVerdict(src, contractAddress) {
        let read;
        try {
            read = await this.vm.readManifest(src, {
                network: this.network,
                contractAddress,
                blockContext: { height: this.block.height, timestamp: this.block.timestamp }
            });
        } catch (e) {
            return { valid: null, error: 'deploy gate could not run on this host: ' + e.message };
        }
        const policy = manifestPolicyError(read);
        if (policy) return { valid: false, error: policy };
        if (!isContractMetaRequiredActive(this.network, this.block.timestamp)) return { valid: true };
        const meta = contractMetaError(read);
        return meta ? { valid: false, error: meta } : { valid: true };
    },

    /**
     * Warn once per simulator when the deploy gate rejects a source. Fires only on
     * a REJECT, so a clean contract keeps the simulator silent, and once per
     * instance for the same reason the two block-gate warnings are (see
     * warnIfPreGate): a per-call warning trains authors to ignore it.
     */
    warnDeployGate(verdict) {
        if (this._deployGateWarned) return;
        this._deployGateWarned = true;
        if (verdict.valid === null) {
            console.warn('[xchain-vm simulator] ' + verdict.error +
                '; deployGate.valid is null, which is NOT a pass. `xchain-foundry lint` runs ' +
                'the acorn half of the same gate without an isolate.');
            return;
        }
        // A manifest-leg error is already the status the chain writes; a lint-leg one is wrapped.
        const status = /^invalid: /.test(String(verdict.error))
            ? verdict.error : 'invalid: CODE_ENCODING (...)';
        console.warn(
            '[xchain-vm simulator] the DEPLOY gate rejects this contract: ' + verdict.error +
            '. On chain xchain-indexer records `' + status + '` and the contract ' +
            'never exists, so any call() result below is simulation-only. The verdict rides ' +
            'back on deploy() as `deployGate`; `xchain-foundry lint` reports it without an isolate.'
        );
    }
};
