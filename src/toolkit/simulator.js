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
 * XChain VM Toolkit: local contract simulator (in-memory indexer mock)
 *
 * ContractSimulator wraps the XChainVM library in the minimal slice of the
 * indexer's per-block behavior a contract author needs: deploy a contract,
 * call methods against PERSISTED state, seed balances / token info / oracle
 * prices, inspect emitted actions and gas, and advance blocks. It is the
 * "run and unit-test a contract with millisecond feedback, no regtest stack"
 * half of the developer on-ramp (see the Tier-2 on-ramp proposal).
 *
 * What it faithfully mirrors from xchain-indexer:
 *   - state commit: after a successful execute, stateChanges are applied and
 *     stateDeletes removed from the contract's own k/v store (the indexer
 *     commits VM output to the contract's state rows).
 *   - block lifecycle: beginBlock / endBlock bracket execution; the compile
 *     cache is per-block and cleared on advance.
 *   - read-only snapshots: balances, tokenInfo, and the oracle are passed as
 *     the same plain-snapshot shapes the indexer threads into execute().
 *   - failure atomicity: on a reverted / out-of-gas / errored call the VM
 *     returns empty stateChanges + emittedActions, so nothing is committed.
 *
 * What it does NOT do (out of scope; that is the real indexer + regtest):
 *   - process emitted ACTIONs against the ledger (SEND/ISSUE/... are captured
 *     for assertions, never applied to balances). getBalance reads only what
 *     the author seeds.
 *   - resolve emit.execute / emit.crossExecute call trees. Those emissions are
 *     captured; the callee is not auto-run.
 *
 * Runtime: execution needs the isolated-vm binding, which loads on Node 22 /
 * Linux (the whole platform's runtime). On a macOS dev box the binding cannot
 * dlopen; use `xchain-foundry lint` (static gate, no isolate) locally and run
 * `simulate` / the generated tests on Node-22 Linux (CI).
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('../index.js');
const { toContractJs } = require('./transpile.js');
const { MAX_CODE_SIZE } = require('../lint-core.js');

// Canonical VM gas schedule (matches the component-doc Gas Schedule table and
// the indexer's VM fee rows). Every CANONICAL_GAS_KEYS entry the VM charges is
// present; the indexer passes extra fee keys the VM ignores.
const DEFAULT_GAS_SCHEDULE = Object.freeze({
    VM_COMPUTATION: 1,
    VM_STATE_READ: 100,
    VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000,
    VM_XCALL_CALLBACK: 20000
});

const DEFAULT_LIMITS = Object.freeze({
    maxCpuTimeMs: 30000,
    maxMemory: 8,
    maxEmissions: 50,
    maxStateKeys: 10000,
    maxStateValueSize: 65536,
    maxCodeSize: MAX_CODE_SIZE,
    maxCallDepth: 4,
    minCallGas: 5000
});

class ContractSimulator {
    /**
     * @param {object} [opts]
     * @param {string} [opts.coin='BTC']     - coin ticker for default C:{COIN}:{i} addresses
     * @param {string} [opts.network='regtest'] - VM network (regtest = all 2.0.0 gates active)
     * @param {number} [opts.gasCeiling=1000000]
     * @param {object} [opts.gasSchedule]    - override the canonical schedule
     * @param {object} [opts.limits]         - override the default resource limits
     * @param {object} [opts.block]          - initial { height, timestamp, hash }
     * @param {string} [opts.defaultCaller]  - caller address used when a call omits one
     * @param {string} [opts.execution='in-process'] - VM execution mode. The
     *        simulator defaults to in-process for millisecond author-time
     *        feedback (no per-block fork); production embedders use 'subprocess'.
     */
    constructor(opts = {}) {
        this.coin = opts.coin || 'BTC';
        this.network = opts.network || 'regtest';
        this.gasCeiling = opts.gasCeiling || 1000000;
        this.gasSchedule = Object.assign({}, DEFAULT_GAS_SCHEDULE, opts.gasSchedule || {});
        this.limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
        this.defaultCaller = opts.defaultCaller || 'sim_caller';

        this.block = Object.assign(
            { height: 1, timestamp: 1700000000, hash: 'sim_block_0000000000000001' },
            opts.block || {}
        );

        // Read-only snapshots the author seeds.
        this.balances = {};        // address -> tick -> amountStr
        this.tokenInfo = {};       // tick -> info object
        this.oracle = { snapshotAge: 0, prices: {}, rounds: {} };
        this.crossChainData = { attestations: {}, settled: {}, calls: {} };

        // Deployed contracts: index -> { code, address, state }
        this.contracts = new Map();
        this._nextIndex = 0;

        // in-process by default: author-time feedback wants no per-block fork.
        // Passing it explicitly also silences the VM's "no execution mode
        // configured" containment warning (the message's prescribed ack).
        this.vm = new XChainVM({
            gasSchedule: this.gasSchedule,
            gasCeiling: this.gasCeiling,
            limits: this.limits,
            execution: opts.execution || 'in-process'
        });
        this.vm.beginBlock();
        this._blockOpen = true;
    }

    // ---- read-only-state seeding -------------------------------------------

    /** Seed an address's balance of a tick (read by contract getBalance). */
    setBalance(address, tick, amount) {
        if (!this.balances[address]) this.balances[address] = {};
        this.balances[address][tick] = String(amount);
        return this;
    }

    /** Read a seeded balance (mirrors the contract's getBalance view). */
    getBalance(address, tick) {
        return (this.balances[address] && this.balances[address][tick]) || null;
    }

    /** Seed token metadata (read by contract getTokenInfo). */
    setTokenInfo(tick, info) {
        this.tokenInfo[tick] = info;
        return this;
    }

    /**
     * Seed an oracle price for a coin pair.
     * @param {string} pair
     * @param {string|number|object} price - a scalar price, or a full
     *        { price, roundNumber, timestamp } record.
     */
    setPrice(pair, price) {
        const rec = (price && typeof price === 'object')
            ? {
                price: String(price.price),
                roundNumber: price.roundNumber != null ? Number(price.roundNumber) : 0,
                timestamp: price.timestamp != null ? Number(price.timestamp) : this.block.timestamp
              }
            : { price: String(price), roundNumber: 0, timestamp: this.block.timestamp };
        this.oracle.prices[pair] = rec;
        if (!this.oracle.rounds[pair]) this.oracle.rounds[pair] = {};
        this.oracle.rounds[pair][String(rec.roundNumber)] = rec;
        return this;
    }

    /** Set the oracle snapshot age (seconds) reported by getSnapshotAge(). */
    setOracleSnapshotAge(seconds) {
        this.oracle.snapshotAge = Number(seconds);
        return this;
    }

    // ---- block control ------------------------------------------------------

    /** Merge fields into the current block context ({ height, timestamp, hash }). */
    setBlock(partial) {
        Object.assign(this.block, partial || {});
        return this;
    }

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
    }

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
     * @returns {Promise<{contractIndex, contractAddress, initResult}>}
     */
    async deploy(code, opts = {}) {
        const src = toContractJs(code, opts.filename || '');
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
        return { contractIndex: index, contractAddress: address, initResult };
    }

    /**
     * Execute a method on a deployed contract against its persisted state.
     * @param {number} contractIndex
     * @param {string} [method='default']
     * @param {string[]} [params=[]]
     * @param {object} [opts]
     * @param {string} [opts.caller]
     * @param {number} [opts.gasLimit] - per-call ceiling (clamped to gasCeiling)
     * @returns {Promise<object>} the VM execute() result, unchanged.
     */
    async call(contractIndex, method = 'default', params = [], opts = {}) {
        const contract = this.contracts.get(Number(contractIndex));
        if (!contract) {
            throw new Error('no contract deployed at index ' + contractIndex);
        }

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
            crossChainData: this.crossChainData
        };
        if (opts.gasLimit != null) execOpts.gasCeiling = Number(opts.gasLimit);

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
    }

    // ---- inspection ---------------------------------------------------------

    /** Snapshot a deployed contract's current committed state (a copy). */
    getState(contractIndex) {
        const c = this.contracts.get(Number(contractIndex));
        return c ? Object.assign({}, c.state) : null;
    }

    /** Read one committed state value (or null). */
    getStateValue(contractIndex, key) {
        const c = this.contracts.get(Number(contractIndex));
        return (c && Object.prototype.hasOwnProperty.call(c.state, key)) ? c.state[key] : null;
    }

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
}

module.exports = { ContractSimulator, DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS };
