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
 *   - read-only snapshots: balances, tokenInfo, the oracle, cross-chain,
 *     attestation, poll and contract-stake data are passed as the same
 *     plain-snapshot shapes the indexer threads into execute().
 *   - controller-guard mode: callGuard() reproduces the indexer's
 *     runControllerGuard invocation (method `guard`, seven positional string
 *     params, isGuard, attestationData null, callPath '') at the same
 *     GUARD_GAS_CEILING the coin configs set, so a guard calling
 *     attestation.request / emit.crossExecute fails in simulation exactly as
 *     it fails on chain instead of simulating green at 5x the gas headroom.
 *   - failure atomicity: on a reverted / out-of-gas / errored call the VM
 *     returns empty stateChanges + emittedActions, so nothing is committed.
 *   - metering activation: the default block time sits at the VM's newest
 *     block-time flag-day, so the gas-metering legs every live chain runs today
 *     are ON and gasUsed is a live-rule-set number. Pin an earlier
 *     block.timestamp to simulate the pre-activation rules (it warns once).
 *   - height-gate activation: the default block HEIGHT sits at the newest armed
 *     per-coin activation for the configured (coin, network), so a mainnet
 *     simulation runs the Package-3 sandbox and the other height-keyed gates the
 *     live chain runs. regtest/testnet stay at height 1 (genesis-active). Pin a
 *     lower height to simulate the pre-activation rules (it warns once).
 *
 * What it does NOT do (out of scope; that is the real indexer + regtest):
 *   - process emitted ACTIONs against the ledger (SEND/ISSUE/... are captured
 *     for assertions, never applied to balances). getBalance reads only what
 *     the author seeds.
 *   - resolve emit.execute / emit.crossExecute call trees. Those emissions are
 *     captured; the callee is not auto-run.
 *   - ASSIGN the identity discriminators a real node assigns. txHash,
 *     actionIndex, rootActionIndex and callPath default to empty/null and are
 *     only forwarded, never derived, so a simulated request_id / call_id
 *     matches chain only when the caller supplies the real values.
 *   - populate the read-only snapshots. They start empty and read back
 *     null / '0' / [] until seeded, which is the same answer a node gives for
 *     data that genuinely does not exist; a stale seed is the author's.
 *   - adjudicate a guard's VERDICT. callGuard runs the guard and commits its
 *     state on VM success; the indexer additionally parses the returned
 *     payoutLegs and DENIES (committing nothing) on a malformed leg or one
 *     over CONTROLLER_MAX_TAKE_BPS. Assert the returnValue yourself.
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
const { VM_MAX_CALL_DEPTH, VM_MIN_CALL_GAS } = require('../protocol/constants.js');

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

// Default simulated block time. Every block-TIME-keyed metering activation in
// the VM -- F3 binary-constructor and F3-globals metering, the O(n)-copy meter
// upgrades, math-output metering, the emission proto-strip, the non-finite gas
// clamp -- compares blockContext.timestamp against a *_GATE_BLOCK_TIME constant
// with NO network term, unlike the network-aware gates (async surface, lint
// hardening, state-key, Pkg-3 sandbox) that regtest activates from genesis. On
// mainnet three of those are keyed on block HEIGHT per coin instead, which is
// what defaultBlockHeight() below derives (see HEIGHT_GATES). So
// `network: 'regtest'` does NOT turn the meters on; only the block time does. A
// default below the newest flag-day meters under a rule set no live chain runs:
// measured on Node 22 / Linux, `new Uint8Array(100000)` costs 225 gas at the old
// 1700000000 default and 100228 gas at the flag-day.
//
// Read off the VM's own exported gate constants rather than retyping one, and
// take the MAX so a later-dated flag day cannot silently strand the simulator
// below it. Every activation compares with `>=`, so sitting exactly on the
// newest gate activates all of them. The literal fallback is the ratified 2.0.0
// flag-day (2026-08-07 00:00:00 UTC) and is reached only if the VM stops
// exporting the constants at all.
const GATE_BLOCK_TIMES = Object.keys(XChainVM)
    .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && Number.isFinite(XChainVM[k]))
    .map((k) => XChainVM[k]);
const DEFAULT_BLOCK_TIME = GATE_BLOCK_TIMES.length ? Math.max(...GATE_BLOCK_TIMES) : 1786060800;

// The sibling class of activations, keyed on block HEIGHT per coin rather than on
// block time: the Package-3 sandbox bundle, the execute-time source re-lint and the
// lint global-alias refinement all resolve `<COIN>:<network>` against a threshold
// map. testnet/regtest are genesis-active, so only mainnet (and any other network
// string) has a height to reach; a default of 1 there runs the PRE-activation rule
// set, which BTC:mainnet left behind at 961000 (~2026-08-04). Each entry names the
// exported map and the exported predicate, so the toolkit reads the consensus
// decision instead of restating it.
const HEIGHT_GATES = Object.freeze([
    { label: 'Pkg-3 sandbox',          map: 'PKG3_SANDBOX_ACTIVATION',      isActive: 'isPkg3SandboxActive' },
    { label: 'execute-time re-lint',   map: 'EXEC_LINT_ACTIVATION',         isActive: 'isExecLintActive' },
    { label: 'lint global-alias',      map: 'LINT_GLOBAL_ALIAS_ACTIVATION', isActive: 'isLintGlobalAliasActive' }
]);

// Networks whose height gates open at genesis, so no height can be "too low".
const GENESIS_ACTIVE_NETWORKS = Object.freeze(['regtest', 'testnet']);

/**
 * Armed threshold for one height gate at (coin, network), or undefined.
 * EXEC_LINT / LINT_GLOBAL_ALIAS still carry an explicit `null` sentinel on every
 * mainnet coin, which means UNARMED, so it is filtered out rather than coerced to 0.
 */
function heightGateThreshold(gate, coin, network) {
    const map = XChainVM[gate.map];
    if (!map || coin == null) return undefined;
    const t = map[String(coin) + ':' + String(network)];
    return Number.isFinite(t) ? t : undefined;
}

/**
 * Default simulated block height for (coin, network): the MAX armed threshold across
 * the height gates, so sitting on it activates all of them (every predicate compares
 * with `>=`), exactly as DEFAULT_BLOCK_TIME does for the block-time gates. Read off
 * the VM's exported maps, never retyped, so a newly ratified height needs no edit
 * here. Genesis-active networks and an unrecognized coin/network keep the historical 1.
 */
function defaultBlockHeight(coin, network) {
    if (GENESIS_ACTIVE_NETWORKS.indexOf(network) !== -1) return 1;
    const armed = HEIGHT_GATES
        .map((g) => heightGateThreshold(g, coin, network))
        .filter((t) => Number.isFinite(t));
    return armed.length ? Math.max(...armed) : 1;
}

// Gas ceiling a controller guard runs under. The indexer reads it from
// GAS_SCHEDULE.VM_GUARD_GAS_CEILING per coin (xchain-indexer/src/coins/BTC.js,
// DOGE.js, LTC.js all set 200000) and REFUSES to default it
// (utility.resolveGuardGasCeiling throws when it is missing), so there is no
// canonical value to import; this is a second home for that number and a
// deliberate one. A guard's real headroom is 5x smaller than the simulator's
// 1000000 default, which is the whole reason it is pinned here rather than
// left to the author. test/toolkit/simulator.test.js pins the value so a
// change is a test-breaking act, never a silent one.
const GUARD_GAS_CEILING = 200000;

// Method name the indexer invokes on a token's bound controller contract
// (xchain-indexer/src/actions/execute.js GUARD_METHOD).
const GUARD_METHOD = 'guard';

// Positional, all-string guard inputs, in consensus order
// (xchain-indexer/src/actions/execute.js runControllerGuard). Named here so
// callGuard cannot drift from the order the chain actually passes.
const GUARD_PARAM_ORDER = Object.freeze([
    'actionType', 'from', 'to', 'tick', 'amount', 'price', 'proceedsTick'
]);

const DEFAULT_LIMITS = Object.freeze({
    maxCpuTimeMs: 30000,
    maxMemory: 8,
    maxEmissions: 50,
    maxStateKeys: 10000,
    maxStateValueSize: 65536,
    maxCodeSize: MAX_CODE_SIZE,
    // Imported, not retyped: index.js back-fills a caller's limits from these
    // same two constants, so a literal here would be a second copy that can
    // silently disagree with the VM the simulator is wrapping.
    maxCallDepth: VM_MAX_CALL_DEPTH,
    minCallGas: VM_MIN_CALL_GAS
});

class ContractSimulator {
    /**
     * @param {object} [opts]
     * @param {string} [opts.coin='BTC']     - coin ticker for default C:{COIN}:{i} addresses
     * @param {string} [opts.network='regtest'] - VM network. This selects the
     *        NETWORK-AWARE gates only (the async/Promise surface, lint
     *        hardening, the state-key gates, the Package-3 sandbox bundle),
     *        which regtest/testnet activate from genesis. Gas-METERING
     *        activation carries no network term at all: it follows
     *        opts.block.timestamp (see DEFAULT_BLOCK_TIME). On mainnet the
     *        Package-3 sandbox, the execute-time re-lint and the lint
     *        global-alias refinement are per-coin block-HEIGHT gates, so there
     *        they follow opts.block.height and opts.coin together.
     * @param {number} [opts.gasCeiling=1000000]
     * @param {object} [opts.gasSchedule]    - override the canonical schedule
     * @param {object} [opts.limits]         - override the default resource limits
     * @param {object} [opts.block]          - initial { height, timestamp, hash }.
     *        timestamp defaults to the VM's newest *_GATE_BLOCK_TIME, so the
     *        block-time-keyed meters are ON and gas matches a live chain; a
     *        lower value simulates the pre-activation rule set and warns once.
     *        height defaults to the newest ARMED activation height for
     *        (coin, network) across the exported per-coin gate maps -- 1 on
     *        regtest/testnet, which activate from genesis -- so a mainnet
     *        simulation runs today's rule set; a lower value warns once too.
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

        // Height, like the timestamp, is DERIVED from the activations it has to
        // clear; the hash follows the height so it keeps advanceBlock's own naming.
        const height0 = defaultBlockHeight(this.coin, this.network);
        this.block = Object.assign(
            {
                height: height0,
                timestamp: DEFAULT_BLOCK_TIME,
                hash: 'sim_block_' + String(height0).padStart(16, '0')
            },
            opts.block || {}
        );
        // One pre-flag-day warning per instance, not per call (see _warnIfPreGate).
        this._preGateWarned = false;
        // Likewise for the height-gate warning (see _warnIfPreHeightGate).
        this._preHeightGateWarned = false;

        // Read-only snapshots the author seeds.
        this.balances = {};        // address -> tick -> amountStr
        this.tokenInfo = {};       // tick -> info object
        this.oracle = { snapshotAge: 0, prices: {}, rounds: {} };
        this.crossChainData = { attestations: {}, settled: {}, calls: {} };
        // The remaining read-only snapshots the gateway reads. Shapes are the
        // ones src/readonly-accessors.js documents; an empty snapshot is
        // behaviour-identical to a null one, because the gateway's own
        // null-guards return the same null / '0' / [] it resolves to.
        this.attestationData   = { responses: {} };
        this.pollData          = { polls: {} };
        this.contractStakeData = { stakeByPubkeyTick: {}, totalByTick: {}, stakersByTick: {} };

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

    /**
     * Seed a settled ATTEST response (read by attestation.getResponse in a
     * callback method). Keys are request_ids; the simulator does not derive
     * them, so pass the id your callback will be handed.
     */
    setAttestationResponse(requestId, value) {
        this.attestationData.responses[String(requestId)] = value;
        return this;
    }

    /**
     * Seed a finalized VOTE poll result (read by poll.getPollResult).
     * @param {number|string} pollIndex - the VOTE v0 action_index
     * @param {object} result - { status, winning_option, total_weight,
     *        total_voters, decided_early, options:[{index,weight,voters}] }
     */
    setPollResult(pollIndex, result) {
        this.pollData.polls[String(pollIndex)] = result;
        return this;
    }

    /**
     * Seed one staker's stake on THIS contract, keeping the three derived
     * views the accessor reads in agreement. `stakersByTick` is what
     * stake.getStakers returns verbatim, so it is kept sorted by descending
     * amount here the way the indexer pre-sorts it.
     * @param {string} pubkey
     * @param {string} tick
     * @param {string|number} amount
     */
    setStake(pubkey, tick, amount) {
        const pk = String(pubkey || '').toLowerCase();
        const tk = String(tick || '');
        const amt = String(amount);
        const key = pk + '|' + tk;
        const prev = this.contractStakeData.stakeByPubkeyTick[key];
        this.contractStakeData.stakeByPubkeyTick[key] = amt;

        const list = (this.contractStakeData.stakersByTick[tk] || []).filter((s) => s.pubkey !== pk);
        if (Number(amt) !== 0) list.push({ pubkey: pk, amount: amt });
        list.sort((a, b) => (Number(b.amount) - Number(a.amount)) || (a.pubkey < b.pubkey ? -1 : 1));
        this.contractStakeData.stakersByTick[tk] = list;

        // Recomputed from the roster rather than accumulated, so re-seeding the
        // same pubkey replaces its stake instead of double-counting it (prev is
        // read only to make that intent explicit at the call site).
        void prev;
        this.contractStakeData.totalByTick[tk] =
            String(list.reduce((sum, s) => sum + Number(s.amount), 0));
        return this;
    }

    /** Seed a cross-chain attestation value (read by crosschain.getAttestation). */
    setCrossChainAttestation(chain, actionIndex, value) {
        this.crossChainData.attestations[String(chain) + ':' + String(actionIndex)] = value;
        return this;
    }

    /** Mark a cross-chain action settled (read by crosschain.isSettled). */
    setCrossChainSettled(chain, actionIndex, settled = true) {
        this.crossChainData.settled[String(chain) + ':' + String(actionIndex)] = settled === true;
        return this;
    }

    /**
     * Seed the terminal outcome of a cross-chain call this chain originated
     * (read by crosschain.getCallResult). Keys are lower-cased call_ids,
     * matching the accessor's own lookup.
     */
    setCallResult(callId, result) {
        this.crossChainData.calls[String(callId).toLowerCase()] =
            { status: String(result && result.status), payload: String(result && result.payload) };
        return this;
    }

    // ---- block control ------------------------------------------------------

    /**
     * Warn once per simulator when the simulated block time sits below the VM's
     * newest metering flag-day. Every block-time-keyed meter is OFF down there,
     * so the gasUsed this run reports is a pre-activation number no live chain
     * charges. Deliberate below-gate runs are legitimate (the VM's own gated
     * fixtures do exactly that), so this warns rather than throwing.
     */
    _warnIfPreGate() {
        if (this._preGateWarned) return;
        if (Number(this.block.timestamp) >= DEFAULT_BLOCK_TIME) return;
        this._preGateWarned = true;
        console.warn(
            '[xchain-vm simulator] block.timestamp ' + this.block.timestamp + ' predates the VM ' +
            'metering flag-day ' + DEFAULT_BLOCK_TIME + ': the block-time-keyed gas meters are OFF, ' +
            'so gasUsed UNDER-REPORTS what a live chain charges. Use the default block, ' +
            'setBlock({ timestamp: ' + DEFAULT_BLOCK_TIME + ' }) or advanceBlock({ byTime }) to ' +
            'simulate the live rule set.'
        );
    }

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
    _warnIfPreHeightGate(contractAddress) {
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
    }

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
     * @param {string} [opts.txHash]   - identity pass-throughs. Forwarded
     * @param {number} [opts.actionIndex]       verbatim; the VM does its own
     * @param {string|number} [opts.rootActionIndex]  normalization. Supply them
     * @param {string} [opts.callPath]          to make a derived request_id /
     * @param {number} [opts.callDepth]         call_id match a real one.
     * @param {object} [opts.providerDeadlines] - ATTEST provider deadline windows
     * @returns {Promise<object>} the VM execute() result, unchanged.
     */
    async call(contractIndex, method = 'default', params = [], opts = {}) {
        return this._execute(contractIndex, method, params, opts, null);
    }

    /**
     * Run a token's bound controller contract in the mode the indexer runs it,
     * mirroring runControllerGuard (xchain-indexer/src/actions/execute.js).
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
        return this._execute(contractIndex, GUARD_METHOD, params, opts, {
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
    }

    /**
     * Shared execute path for call() and callGuard(). `modeOverrides` is applied
     * LAST so a mode owns the keys it pins; everything else stays exactly as
     * call() has always built it.
     */
    async _execute(contractIndex, method, params, opts, modeOverrides) {
        const contract = this.contracts.get(Number(contractIndex));
        if (!contract) {
            throw new Error('no contract deployed at index ' + contractIndex);
        }
        this._warnIfPreGate();
        this._warnIfPreHeightGate(contract.address);

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

module.exports = {
    ContractSimulator, DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS, DEFAULT_BLOCK_TIME,
    GUARD_GAS_CEILING, GUARD_METHOD, GUARD_PARAM_ORDER
};
