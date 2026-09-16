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

const { toContractJs } = require('../transpile.js');
const { GUARD_GAS_CEILING, GUARD_METHOD, GUARD_PARAM_ORDER } = require('./constants.js');

module.exports = {
    /** Merge fields into the current block context ({ height, timestamp, hash }). */
    setBlock(partial) {
        Object.assign(this.block, partial || {});
        return this;
    },

    /**
     * Close the current block and open the next one (clears the per-block
     * compile cache, exactly like the indexer between blocks).
     * @param {object} [o]
     * @param {number} [o.byTime=600] - seconds to advance the timestamp
     * @param {string} [o.hash]       - explicit next block hash
     */
    advanceBlock(o = {}) {
        if (this._blockOpen) this.vm.endBlock();
        this.block.height += 1;
        this.block.timestamp += (o.byTime != null ? Number(o.byTime) : 600);
        this.block.hash = o.hash || ('sim_block_' + String(this.block.height).padStart(16, '0'));
        this.vm.beginBlock();
        this._blockOpen = true;
        return this;
    },

    // ---- deploy / call ------------------------------------------------------

    /**
     * Register a contract (and optionally run its `initialize` constructor).
     * @param {string} code - contract source (JS, or TS if opts.filename is *.ts)
     * @param {object} [opts]
     * @param {number} [opts.contractIndex] - explicit index (default auto)
     * @param {string} [opts.contractAddress] - explicit address (default C:{coin}:{i})
     * @param {object} [opts.state] - initial state k/v
     * @param {string} [opts.filename] - drives TS detection (.ts -> type-strip)
     * @param {string[]} [opts.constructorParams] - if present, runs `initialize`
     * @param {string} [opts.caller]
     * @returns {Promise<{contractIndex, contractAddress, initResult, deployGate}>}
     *          deployGate is the chain's deploy verdict, `{ valid: true }` or
     *          `{ valid: false, error }`. Advisory: a reject warns once and the
     *          contract is still registered (see deployGateVerdict).
     */
    async deploy(code, opts = {}) {
        const src = toContractJs(code, opts.filename || '');
        const deployGate = this.deployGateVerdict(src);
        if (deployGate.valid !== true) this.warnDeployGate(deployGate);
        const index = (opts.contractIndex != null) ? Number(opts.contractIndex) : this._nextIndex;
        if (index >= this._nextIndex) this._nextIndex = index + 1;
        const address = opts.contractAddress || ('C:' + this.coin + ':' + index);

        this.contracts.set(index, {
            code: src,
            address,
            state: Object.assign({}, opts.state || {})
        });

        let initResult = null;
        if (opts.constructorParams !== undefined) {
            initResult = await this.call(index, 'initialize', opts.constructorParams, {
                caller: opts.caller
            });
        }
        return { contractIndex: index, contractAddress: address, initResult, deployGate };
    },

    /**
     * Execute a method on a deployed contract against its persisted state.
     * @param {number} contractIndex
     * @param {string} [method='default']
     * @param {string[]} [params=[]]
     * @param {object} [opts]
     * @param {string} [opts.caller]
     * @param {number} [opts.gasLimit] - per-call ceiling (clamped to gasCeiling)
     * @param {string} [opts.txHash]   - identity pass-throughs. Forwarded
     * @param {number} [opts.actionIndex]       verbatim; the VM does its own
     * @param {string|number} [opts.rootActionIndex]  normalization. Supply them
     * @param {string} [opts.callPath]          to make a derived request_id /
     * @param {number} [opts.callDepth]         call_id match a real one.
     * @param {object} [opts.providerDeadlines] - ATTEST provider deadline windows
     * @returns {Promise<object>} the VM execute() result, unchanged.
     */
    async call(contractIndex, method = 'default', params = [], opts = {}) {
        return this.execute(contractIndex, method, params, opts, null);
    },

    /**
     * Run a token's bound controller contract in the mode the indexer runs it,
     * mirroring runControllerGuard (xchain-indexer/src/actions/execute/index.js).
     *
     * Guard mode is a MODE, not a flag on call(), on purpose: under isGuard the
     * chain also passes attestationData null, callPath '' and a 5x smaller gas
     * ceiling. A raw flag lets an author set one of those four and simulate a
     * combination the chain never produces.
     *
     * @param {number} contractIndex
     * @param {object} action - { actionType, from, to, tick, amount, price,
     *        proceedsTick }; each is coerced to a string, absent becomes ''.
     * @param {object} [opts] - as call(), except attestationData is forced null
     *        and callPath is forced ''. gasLimit still overrides the ceiling.
     * @returns {Promise<object>} the VM execute() result, unchanged.
     */
    async callGuard(contractIndex, action = {}, opts = {}) {
        const params = GUARD_PARAM_ORDER.map((k) => {
            const v = action[k];
            return (v === undefined || v === null) ? '' : String(v);
        });
        return this.execute(contractIndex, GUARD_METHOD, params, opts, {
            isGuard: true,
            // A guard has no attestation-request surface (the gateway disables
            // attestation.request under isGuard), so the chain keeps its read
            // surface narrow by passing null here. Seeded responses are NOT
            // visible to a guard, and that is the point.
            attestationData: null,
            // A guard is a root execution for its own subtree.
            callPath: '',
            gasCeiling: (opts.gasLimit != null) ? Number(opts.gasLimit) : GUARD_GAS_CEILING
        });
    },

    /**
     * Shared execute path for call() and callGuard(). `modeOverrides` is applied
     * LAST so a mode owns the keys it pins; everything else stays exactly as
     * call() has always built it.
     */
    async execute(contractIndex, method, params, opts, modeOverrides) {
        const contract = this.contracts.get(Number(contractIndex));
        if (!contract) {
            throw new Error('no contract deployed at index ' + contractIndex);
        }
        this.warnIfPreGate();
        this.warnIfPreHeightGate(contract.address);

        const execOpts = {
            code: contract.code,
            state: contract.state,
            method: method || 'default',
            params: Array.isArray(params) ? params : [],
            caller: opts.caller || this.defaultCaller,
            contractAddress: contract.address,
            contractIndex: Number(contractIndex),
            network: this.network,
            blockContext: {
                height: this.block.height,
                timestamp: this.block.timestamp,
                hash: this.block.hash
            },
            balances: this.balances,
            tokenInfo: this.tokenInfo,
            oracleData: this.oracle,
            crossChainData: this.crossChainData,
            attestationData: this.attestationData,
            pollData: this.pollData,
            contractStakeData: this.contractStakeData,
            // Identity fields. The VM defaults every one of these itself
            // (txHash '', actionIndex null, rootActionIndex null, callPath '',
            // callDepth 0, providerDeadlines null), so an omitted opt lands on
            // exactly the value the simulator produced before they existed.
            txHash: opts.txHash != null ? String(opts.txHash) : '',
            actionIndex: opts.actionIndex != null ? Number(opts.actionIndex) : null,
            rootActionIndex: opts.rootActionIndex != null ? opts.rootActionIndex : null,
            callPath: typeof opts.callPath === 'string' ? opts.callPath : '',
            callDepth: Number.isInteger(opts.callDepth) ? opts.callDepth : 0,
            providerDeadlines: opts.providerDeadlines || null
        };
        if (opts.gasLimit != null) execOpts.gasCeiling = Number(opts.gasLimit);
        if (modeOverrides) Object.assign(execOpts, modeOverrides);

        const result = await this.vm.execute(execOpts);

        // Commit committed state exactly as the indexer does. On failure the VM
        // returns empty change/delete arrays, so this is a no-op then (atomicity).
        if (result && result.success) {
            for (const change of (result.stateChanges || [])) {
                contract.state[change.key] = change.value;
            }
            for (const key of (result.stateDeletes || [])) {
                delete contract.state[key];
            }
        }
        return result;
    },

    // ---- inspection ---------------------------------------------------------

    /** Snapshot a deployed contract's current committed state (a copy). */
    getState(contractIndex) {
        const c = this.contracts.get(Number(contractIndex));
        return c ? Object.assign({}, c.state) : null;
    },

    /** Read one committed state value (or null). */
    getStateValue(contractIndex, key) {
        const c = this.contracts.get(Number(contractIndex));
        return (c && Object.prototype.hasOwnProperty.call(c.state, key)) ? c.state[key] : null;
    },

    /**
     * Close the open block and shut down the VM. Each execute() disposes its own
     * isolate, so the only durable resource is a subprocess-mode worker, which
     * shutdown() reaps. Call when done with the simulator.
     * @returns {Promise<void>}
     */
    async close() {
        if (this._blockOpen) {
            try { this.vm.endBlock(); } catch (e) { /* already closed */ }
            this._blockOpen = false;
        }
        if (typeof this.vm.shutdown === 'function') {
            try { await this.vm.shutdown(); } catch (e) { /* best-effort */ }
        }
    }
};
