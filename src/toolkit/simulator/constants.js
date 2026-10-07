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

// Default simulated block time. Every block-TIME-keyed metering activation in
// the VM -- F3 binary-constructor and F3-globals metering, the O(n)-copy meter
// upgrades, math-output metering, the emission proto-strip, the non-finite gas
// clamp -- compares blockContext.timestamp against a *_GATE_BLOCK_TIME constant
// with NO network term, unlike the network-aware gates (async surface, lint
// hardening, state-key, Pkg-3 sandbox) that regtest activates from genesis. On
// mainnet the height-keyed gates are keyed on block HEIGHT per coin instead, which is
// what defaultBlockHeight() below derives (see HEIGHT_GATES). So
// `network: 'regtest'` does NOT turn these scalar meters on; only the block time
// does. (The network-keyed meters, such as the iter/Set/apply meter and gas-ceiling
// success, are the exception: regtest runs them from genesis, mainnet not yet.) A
// default below the newest flag-day meters under a rule set no live chain runs:
// measured on Node 22 / Linux, `new Uint8Array(100000)` costs 225 gas at the old
// 1700000000 default and 100228 gas at the flag-day.
//
// Read off the VM's own exported gate constants rather than retyping one. Two
// anchors come out of that list, and the distinction is the whole point:
//
//   LIVE (the default) is the newest gate that has ALREADY ELAPSED, so a default
//   simulation meters and deploy-validates under the rule set a live chain is
//   running at this moment.
//   SCHEDULED is the max over every ARMED gate, elapsed or not, so a future-dated
//   flag-day can be previewed on purpose.
//
// A single MAX cannot be both. A future-dated gate turns it into a preview of
// rules no chain runs yet: with REST_PATTERN_METER dated 2027-01-01, a MAX-seeded
// default mainnet simulation rejects top-level rest destructuring that mainnet
// accepts and charges size for rest copies mainnet does not charge, silently.
// The split keeps the property the MAX is there for (a newly dated flag day can
// never strand a simulation below an ACTIVE gate, because every elapsed gate is
// in the live max) and ends the silent early activation.
//
// Every activation compares with `>=`, so sitting exactly on a gate activates
// it. The literal fallback is the ratified 2.0.0 flag-day (2026-08-07 00:00:00
// UTC) and is reached only if the VM stops exporting the constants at all, or
// if no gate has elapsed yet.
// A gate at or above UNARMED_GATE_BLOCK_TIME is a placeholder awaiting its release
// cut (JSON_STRINGIFY_HOOK today), never a ratified flag day, so neither anchor sees it.
const UNARMED_GATE_BLOCK_TIME = 9999999999;
const isArmedGateTime = (t) => Number.isFinite(t) && t < UNARMED_GATE_BLOCK_TIME;
const GATE_BLOCK_TIMES = Object.keys(XChainVM)
    .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && isArmedGateTime(XChainVM[k]))
    .map((k) => XChainVM[k]);
const GATE_FALLBACK_BLOCK_TIME = 1786060800;

// The sibling class of activations, keyed on block HEIGHT per coin rather than on
// block time: the Package-3 sandbox bundle, the execute-time source re-lint, the
// lint global-alias refinement and the lint optional-chain refinement all resolve
// `<COIN>:<network>` against a threshold map. Whether a gate is on from genesis is
// decided per gate by its own predicate, never per network (the optional-chain
// gate is genesis-on for regtest only and needs a threshold on testnet). A default
// of 1 below an armed threshold runs the PRE-activation rule set, which BTC:mainnet
// left behind at 961000 (~2026-08-04). Each entry names the exported map and the
// exported predicate, so the toolkit reads the consensus decision instead of
// restating it; test/toolkit/simulator_height_gates.test.js holds the table
// complete against the VM's exported `*_ACTIVATION` maps.
const HEIGHT_GATES = Object.freeze([
    { label: 'Pkg-3 sandbox',          map: 'PKG3_SANDBOX_ACTIVATION',        isActive: 'isPkg3SandboxActive' },
    { label: 'execute-time re-lint',   map: 'EXEC_LINT_ACTIVATION',           isActive: 'isExecLintActive' },
    { label: 'lint global-alias',      map: 'LINT_GLOBAL_ALIAS_ACTIVATION',   isActive: 'isLintGlobalAliasActive' },
    { label: 'lint optional-chain',    map: 'LINT_OPTIONAL_CHAIN_ACTIVATION', isActive: 'isLintOptionalChainActive' }
]);

// Gas ceiling a controller guard runs under. The indexer reads it from
// GAS_SCHEDULE.VM_GUARD_GAS_CEILING per coin (xchain-indexer/src/coins/BTC.js,
// DOGE.js, LTC.js all set 200000) and REFUSES to default it
// (utility.resolveGuardGasCeiling throws when it is missing), so there is no
// canonical value to import; this is a second home for that number and a
// deliberate one. A guard's real headroom is 5x smaller than the simulator's
// 1000000 default, which is the whole reason it is pinned here rather than
// left to the author. test/determinism/simulator-defaults-cross-repo.test.js
// compares this constant against GAS_SCHEDULE.VM_GUARD_GAS_CEILING in the
// sibling coin configs, so a coin-side re-pricing reddens this repo instead of
// leaving simulate quoting stale headroom; test/toolkit/simulator.test.js keeps
// a literal pin for a standalone clone with no sibling to read.
const GUARD_GAS_CEILING = 200000;

// Method name the indexer invokes on a token's bound controller contract
// (xchain-indexer/src/actions/execute/controller_guard.js GUARD_METHOD).
const GUARD_METHOD = 'guard';

// Positional, all-string guard inputs, in consensus order
// (xchain-indexer/src/actions/execute/controller_guard.js runControllerGuard). Named here so
// callGuard cannot drift from the order the chain actually passes.
const GUARD_PARAM_ORDER = Object.freeze([
    'actionType', 'from', 'to', 'tick', 'amount', 'price', 'proceedsTick'
]);

// Activation instants of CONTRACT_META_REQUIRED, the indexer's deploy rule that a
// contract export a conforming `meta`. The rule is an indexer registry row with no
// VM twin, so these are a deliberate second home for its flag times
// (xchain-indexer/src/protocol_changes/flag_times.js), compared against that file by
// test/determinism/simulator_manifest_gate_cross_repo.test.js. Mainnet and regtest are
// genesis-active; any network not named here resolves like mainnet.
const CONTRACT_META_REQUIRED_TIMES = Object.freeze({
    mainnet: 0,
    testnet: 1789257600,
    regtest: 0
});

// Block-TIME gates keyed per NETWORK rather than by one scalar, so GATE_BLOCK_TIMES
// (scalar-only by design) never sees them. Each entry reads its instant off the
// source that decides it, never a retyped value; the live anchor folds in the
// configured network's elapsed entries. test/toolkit/simulator_block_time.test.js
// holds this table complete against the VM's exported network-keyed time maps.
const TIME_NETWORK_GATES = Object.freeze([
    { label: 'JSON.stringify value hooks', source: 'JSON_STRINGIFY_HOOK_ACTIVATION',
        resolve: (network) => XChainVM.jsonStringifyHookGateTime(network) },
    { label: 'CONTRACT_META_REQUIRED', source: 'CONTRACT_META_REQUIRED_TIMES',
        resolve: (network) => CONTRACT_META_REQUIRED_TIMES[
            Object.prototype.hasOwnProperty.call(CONTRACT_META_REQUIRED_TIMES, network) ? network : 'mainnet'] }
]);

module.exports = {
    GATE_BLOCK_TIMES,
    GATE_FALLBACK_BLOCK_TIME,
    UNARMED_GATE_BLOCK_TIME,
    isArmedGateTime,
    HEIGHT_GATES,
    CONTRACT_META_REQUIRED_TIMES,
    TIME_NETWORK_GATES,
    GUARD_GAS_CEILING,
    GUARD_METHOD,
    GUARD_PARAM_ORDER
};
