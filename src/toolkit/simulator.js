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
 *   - REFUSE a deploy the chain's deploy gate would reject. deploy() runs that
 *     gate (code size + validateSyntax, resolved at the configured network /
 *     coin / block) and hands the verdict back as `deployGate`, warning once on a
 *     reject, but it still registers the contract: simulating a source the chain
 *     would not accept is a legitimate move, and this repo's own fixtures do it to
 *     measure the runtime strips. A `deployGate.valid === false` means the later
 *     call() results are simulation-only; on chain the contract never exists.
 *     Note deployGate no longer stands alone here: the VM's execute-time re-lint
 *     rides EXEC_LINT_ACTIVATION, whose mainnet entries are ARMED at genesis by
 *     the 2026-09-09 ruling (identity on the indexed mainnet history: 0 contracts,
 *     0 DEPLOY, 0 EXECUTE, measured 2026-09-09), and call() below reaches it
 *     through this.vm.execute(), so a MAINNET-configured simulator now gets that
 *     second source check too.
 *   - reproduce a HOST-TERMINATION outcome. The default in-process mode has no
 *     worker to lose, so a contract that aborts the JS engine (bulk allocation
 *     past the isolate memory limit is the shape) takes the simulator's own
 *     process down and the author sees a crashed test run. The indexer runs
 *     execution: 'subprocess' (xchain-indexer/src/actions/index.js), where the same
 *     contract kills only the worker and the executor returns the deterministic
 *     `out_of_resource: execution host terminated (...)` with gasUsed at the
 *     ceiling (src/process_executor.js hostTerminatedResult). Pass
 *     execution: 'subprocess' (or `xchain-foundry simulate --execution
 *     subprocess`) to see that result. The wall-clock half of this seam IS
 *     faithful: DEFAULT_LIMITS.maxCpuTimeMs equals CONSENSUS_MAX_WALL_MS.
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
const { MAX_CODE_SIZE } = require('../lint_core.js');
const { VM_MAX_CALL_DEPTH, VM_MIN_CALL_GAS } = require('../protocol/constants.js');
const {
    GATE_BLOCK_TIMES,
    GATE_FALLBACK_BLOCK_TIME,
    GUARD_GAS_CEILING,
    GUARD_METHOD,
    GUARD_PARAM_ORDER
} = require('./simulator/constants.js');
const { liveBlockTime, defaultBlockHeight } = require('./simulator/block_time_gates.js');
const worldStateSetters = require('./simulator/world_state_setters.js');
const gateWarnings = require('./simulator/gate_warnings.js');
const execution = require('./simulator/execution.js');

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

const SCHEDULED_BLOCK_TIME = GATE_BLOCK_TIMES.length
    ? Math.max(...GATE_BLOCK_TIMES)
    : GATE_FALLBACK_BLOCK_TIME;

// Back-compatible name for the seed a default simulator takes, kept exported (and
// re-exported from toolkit/index.js) for callers that read it. It is the LIVE
// anchor; SCHEDULED_BLOCK_TIME above is the preview anchor.
const DEFAULT_BLOCK_TIME = liveBlockTime();

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

function initializeBlockContext(opts) {
    // Which rule set the default anchors on; an unrecognized value reads as
    // 'live', the fail-safe direction (a typo must not silently preview).
    this.rules = (opts.rules === 'scheduled') ? 'scheduled' : 'live';
    // Resolved per construction, never once at module load, so a process that
    // outlives a flag day picks the new rules up on its next simulator. Held on
    // the instance because warnIfPreGate measures against THIS simulator's live
    // anchor rather than a module-wide one.
    this._liveBlockTime = liveBlockTime();
    const time0 = (this.rules === 'scheduled') ? SCHEDULED_BLOCK_TIME : this._liveBlockTime;

    // Height, like the timestamp, is DERIVED from the activations it has to
    // clear; the hash follows the height so it keeps advanceBlock's own naming.
    const height0 = defaultBlockHeight(this.coin, this.network);
    this.block = Object.assign(
        {
            height: height0,
            timestamp: time0,
            hash: 'sim_block_' + String(height0).padStart(16, '0')
        },
        opts.block || {}
    );

    // Scheduled mode is a preview and says so once, naming the gates it turns on
    // ahead of the live chain by constant name, epoch value and UTC date. Suppressed
    // when an explicit block.timestamp won, because then the caller chose the instant
    // and the mode did not seed anything.
    if (this.rules === 'scheduled' && Number(this.block.timestamp) === SCHEDULED_BLOCK_TIME) {
        const early = Object.keys(XChainVM)
            .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && Number.isFinite(XChainVM[k]))
            .filter((k) => XChainVM[k] > this._liveBlockTime)
            .map((k) => k + ' (' + XChainVM[k] + ', ' + new Date(XChainVM[k] * 1000).toISOString() + ')');
        if (early.length) {
            console.warn(
                '[xchain-vm simulator] rules: scheduled simulates block time ' +
                SCHEDULED_BLOCK_TIME + ', which activates ' + early.length + ' gate(s) ahead ' +
                'of the live chain: ' + early.join(', ') + '. Gas and deploy verdicts from ' +
                'this simulator are a PREVIEW, not what a chain charges today.'
            );
        }
    }
    // One pre-flag-day warning per instance, not per call (see warnIfPreGate).
    this._preGateWarned = false;
    // Likewise for the height-gate warning (see warnIfPreHeightGate).
    this._preHeightGateWarned = false;
    // Likewise for the deploy-gate rejection warning (see warnDeployGate).
    this._deployGateWarned = false;
}

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
     * @param {string} [opts.rules='live']    - which rule set the default block time
     *        anchors on. 'live' is the newest ELAPSED *_GATE_BLOCK_TIME, so a
     *        default simulation matches what a live chain runs right now.
     *        'scheduled' is the newest RATIFIED gate including future-dated ones,
     *        for previewing a flag day before it arrives; it warns once, naming
     *        each gate it activates ahead of the live chain. An explicit
     *        opts.block.timestamp wins over either mode.
     * @param {object} [opts.block]          - initial { height, timestamp, hash }.
     *        timestamp defaults to the newest ELAPSED *_GATE_BLOCK_TIME, so the
     *        block-time-keyed meters are ON and gas matches a live chain; a
     *        lower value simulates the pre-activation rule set and warns once.
     *        height defaults to the newest ARMED activation height for
     *        (coin, network) across the exported per-coin gate maps -- 1 on
     *        regtest/testnet, which activate from genesis -- so a mainnet
     *        simulation runs today's rule set; a lower value warns once too.
     * @param {string} [opts.defaultCaller]  - caller address used when a call omits one
     * @param {string} [opts.execution='in-process'] - VM execution mode. Not a
     *        pure latency knob: the two modes differ on a RESULT. in-process
     *        gives millisecond feedback with no per-block fork, but has no worker
     *        to lose, so a contract that aborts the JS engine takes this process
     *        down instead of failing. 'subprocess' forks one worker per
     *        simulator, is the mode the indexer runs, and returns the chain's
     *        deterministic `out_of_resource: execution host terminated (...)`
     *        with gasUsed at the ceiling. Reach for it when a contract crashes
     *        the runner rather than failing.
     */
    constructor(opts = {}) {
        this.coin = opts.coin || 'BTC';
        this.network = opts.network || 'regtest';
        this.gasCeiling = opts.gasCeiling || 1000000;
        this.gasSchedule = Object.assign({}, DEFAULT_GAS_SCHEDULE, opts.gasSchedule || {});
        this.limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
        this.defaultCaller = opts.defaultCaller || 'sim_caller';

        initializeBlockContext.call(this, opts);

        // Read-only snapshots the author seeds.
        this.balances = {};        // address -> tick -> amountStr
        this.tokenInfo = {};       // tick -> info object
        this.oracle = { snapshotAge: 0, prices: {}, rounds: {} };
        this.crossChainData = { attestations: {}, settled: {}, calls: {} };
        // The remaining read-only snapshots the gateway reads. Shapes are the
        // ones src/readonly_accessors.js documents; an empty snapshot is
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
}

Object.assign(
    ContractSimulator.prototype,
    worldStateSetters,
    gateWarnings,
    execution
);

module.exports = {
    ContractSimulator, DEFAULT_GAS_SCHEDULE, DEFAULT_LIMITS, DEFAULT_BLOCK_TIME,
    SCHEDULED_BLOCK_TIME, liveBlockTime,
    GUARD_GAS_CEILING, GUARD_METHOD, GUARD_PARAM_ORDER
};
