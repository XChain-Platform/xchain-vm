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
 * XChain VM: coordinated activations
 *
 * Flag-day and height gates the VM reads, with their resolvers. Each
 * value is a consensus quantity pinned by the consensus-params suites.
 ********************************************************************/
// @ts-nocheck

// Coordinated activation (block time, unix seconds) for binary-allocation gas
// metering (the F3-binary ArrayBuffer/TypedArray byte-length charge in the
// harness below). That charge is a consensus-affecting gas-schedule change: a
// node that applies it and a node that does not produce a different gasUsed for
// the same execution, and gasUsed is hashed into the per-block contract
// checkpoint and drives the fee debit, so applying it to ALL blocks (including
// historical ones) forks any mixed-version fleet on the first binary-allocating
// execution. Gating the metering on a fleet-wide flag-day makes every node flip
// the rule at the same timestamp instead of whenever it happens to upgrade.
// Below the flag day the constructors are UNMETERED (the pre-activation
// behavior); at/after it the byte-length charge applies on every node alike.
// Same coordinated timestamp as the indexer's other 2.0.0 flag-day activations
// (protocol_changes.js). CONFIRMED 2026-07-07 (2026-08-07 00:00:00 UTC); a value
// that differs across the fleet is itself a fork.
const BINARY_ALLOC_GATE_BLOCK_TIME = 1786060800;

// Coordinated activation (block time, unix seconds) for resolving JSON.stringify
// VALUE HOOKS before the native serializer sees the value (__resolveForStringify in
// the harness above). The F-NR native-depth guard that rides
// BINARY_ALLOC_GATE_BLOCK_TIME measures the ARGUMENT and then hands the ORIGINAL
// value to the native serializer, so a toJSON method, a replacer function or an own
// getter can present a shallow value to the guard and a deep one to the serializer,
// putting the host-dependent native overflow (~128KB stack on musl vs ~2MB on glibc)
// back within reach of a contract that catches the RangeError and branches on it.
//
// This needs its OWN, LATER flag day: the binary-alloc activation above is already
// past, and every block executed under it must replay byte-for-byte, so the hook
// resolution cannot be folded into a timestamp that has already armed. At/after this
// timestamp a hook- or accessor-bearing value is resolved once and serialized from a
// materialized copy (moving both its bytes, where a hook was lying, and its gasUsed,
// by the per-node copy charge); below it the value guard behaves exactly as it does
// today. Hook-FREE values are passed through by reference and are byte- and
// gas-identical on both sides of the flag day.
//
// Keep the scalar mainnet literal for existing consumers that pin or parse it.
const JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME = 9999999999;

// Mainnet stays unarmed, testnet arms at block time 1791061097 (2026-10-03 20:58:17 UTC)
// and regtest exercises the rule from genesis.
// Resolve unknown or missing networks like mainnet to retain replay-safe behaviour.
const JSON_STRINGIFY_HOOK_ACTIVATION = Object.seal({
    mainnet: JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME,
    testnet: 1791061097,
    regtest: 0,
});
function jsonStringifyHookGateTime(network) {
    const gate = JSON_STRINGIFY_HOOK_ACTIVATION[network];
    return Number.isFinite(gate) ? gate : JSON_STRINGIFY_HOOK_ACTIVATION.mainnet;
}

// Coordinated activation (block time, unix seconds) for the async/Promise
// contract-surface change (CONSENSUS_VERSION '2'): the sandbox strips the global
// `Promise` (sandbox.js) and the deploy validator rejects async/await/Promise
// (lint-core CONSENSUS_RULES 'banned-async'). Both are consensus-affecting: a
// node that strips Promise / rejects an async DEPLOY and a node that does not
// produce a different gasUsed/status (→ contract_hash → fee debit, and a
// different deploy verdict), so a mixed-version fleet forks on the first
// Promise-referencing execution / async DEPLOY. Gating on a fleet-wide flag-day
// makes every node flip together, and a from-genesis replay reproduces the
// historical accept-below/reject-above verdict at every height.
//
// Network-aware, mirroring the indexer's VM_BANNED_ASYNC / DEPLOY_BASE64_CODE
// protocol_changes activations: mainnet defers to the coordinated flag-day;
// testnet/regtest activate at genesis (the pre-launch nets have no pre-activation
// history to preserve and the e2e/regtest stack already ran with the rule live,
// so keeping it on from block 0 preserves their current behaviour). An unknown /
// empty network is treated like mainnet (conservative: requires the flag-day).
// Same coordinated timestamp value as the indexer's other 2.0.0 flag-days and
// BINARY_ALLOC_GATE_BLOCK_TIME (protocol_changes.js: 1786060800). CONFIRMED
// 2026-07-07 (2026-08-07 00:00:00 UTC); a value that differs across the fleet
// is itself a fork.
const ASYNC_SURFACE_GATE_BLOCK_TIME = 1786060800;

// Resolve whether the async/Promise surface change is active for a given network
// at a given block time. Gates the execution-side Promise strip; the
// deploy-side banned-async rule is gated identically by the indexer via
// protocol_changes.isEnabled('VM_BANNED_ASYNC').
function isAsyncSurfaceActive(network, blockTime) {
    // testnet/regtest: active from genesis (flag day 0).
    if (network === 'testnet' || network === 'regtest') return true;
    // mainnet + unknown/empty: active at/after the coordinated flag-day.
    return Number.isFinite(blockTime) && blockTime >= ASYNC_SURFACE_GATE_BLOCK_TIME;
}

// Coordinated activation (block time, unix seconds) for the VM_LINT_HARDENING
// consensus package (flag-day Pkg 4): the hardened deploy-linter rule set
// (exponentiation ban, reserved control bindings, SAFE_MATH complement,
// dynamic import(), shorthand { Promise }, shadowed-local Promise relaxation
// in lint-core.js), the CONTRACT_WRAPPER control-binding closure move, and the
// corroborated error-classifier tightening below. All are consensus-visible
// (deploy verdicts / execution status / gasUsed), so they flip fleet-wide at
// the ratified flag-day anchor, the same instant banned-async activates (zero
// partially-hardened window). Deploy-side gating is resolved by the indexer
// via protocol_changes.isEnabled('VM_LINT_HARDENING'); execution-side gating
// uses the network-aware resolver below, mirroring its siblings: testnet/
// regtest from genesis, mainnet (and unknown networks, conservative) at the
// flag-day. Same ratified timestamp as the sibling gates (1786060800,
// 2026-08-07 00:00:00 UTC); a divergent value is itself a fork.
const VM_LINT_HARDENING_GATE_BLOCK_TIME = 1786060800;
function isLintHardeningActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= VM_LINT_HARDENING_GATE_BLOCK_TIME;
}

// Coordinated activation for rejecting raw NUL (0x00) bytes in contract state
// keys at the state-write boundary. A NUL-bearing state_key row breaks the
// indexer's 0x00-joined merkle leaf encoding (merkle.js joinFields throws on
// any 0x00-bearing field to keep the join injective), so computing the block
// merkle root wedges every state-commitment indexer at that block: an
// F-12-class liveness halt any deployer can trigger. Rejecting the write
// fails the execution deterministically on every node instead. Consensus-
// visible (a rejected write flips an execution from success to failure), so
// it is gated like the other 2.0.0 contract-era changes: testnet/regtest from
// genesis (pre-launch nets, no history to preserve; a NUL key in committed
// history is impossible anyway since it would have wedged the chain at that
// block), mainnet at the shared coordinated flag-day. Values need no guard:
// they are JSON.stringify'd before storage/hashing, which escapes control
// characters. Same coordinated timestamp as BINARY_ALLOC/ASYNC_SURFACE; a
// value that differs across the fleet is itself a fork.
const STATE_KEY_NUL_GATE_BLOCK_TIME = 1786060800;
function isStateKeyNulRejectActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= STATE_KEY_NUL_GATE_BLOCK_TIME;
}

// Coordinated activation for canonical string state keys. Legacy StateManager
// key handling is type-blind: the max-key-size and NUL guards test
// `typeof key === 'string'` (a non-string key skips both), `key in state`
// string-coerces while the dirty Map is identity-keyed, so `1` and '1' count
// as TWO live keys (two keyCount bumps) that collapse to ONE row when the
// indexer string-coerces the emitted key - an under-count against maxStateKeys
// and a size/NUL-check bypass. Post-gate every key is normalized at one choke
// point: string/number/boolean coerce via String(key) (so `1` and '1' are the
// same key everywhere, and every guard applies to the canonical form);
// object/array/null/undefined keys throw a deterministic error at the state
// boundary (String() would collapse them all to '[object Object]'). Consensus-
// visible (it changes which writes are valid and how keys are counted), so it
// is gated like the other 2.0.0 contract-era changes: testnet/regtest from
// genesis, mainnet at the shared coordinated flag-day. Same coordinated
// timestamp as STATE_KEY_NUL/BINARY_ALLOC/ASYNC_SURFACE; a value that differs
// across the fleet is itself a fork.
const STATE_KEY_TYPE_GATE_BLOCK_TIME = 1786060800;
function isStateKeyTypeNormalizeActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= STATE_KEY_TYPE_GATE_BLOCK_TIME;
}

// Coordinated activation for spec-correct evaluation order of the compound
// string-append `obj[k] += rhs` (L-3). The AST metering transform rewrites this
// to a metered helper call; the legacy rewrite evaluates rhs BEFORE the helper
// reads obj[k], so a contract whose rhs mutates obj[k] observes the post-mutation
// value, diverging from JS spec order (read obj[k] old value FIRST, then evaluate
// rhs). Every node runs the same transform, so this is a shared spec divergence,
// not a cross-node split; but CORRECTING it changes results for that rare pattern,
// so the correction is gated. Post-gate the transform emits __setconcatL (thunked
// rhs, read-first); pre-gate it emits __setconcat verbatim so historical blocks
// replay byte-identically. Gated like the other 2.0.0 contract-era changes:
// testnet/regtest from genesis, mainnet at the shared coordinated flag-day. Same
// coordinated timestamp as STATE_KEY_NUL/BINARY_ALLOC/ASYNC_SURFACE; a value that
// differs across the fleet is itself a fork.
const METERING_EVAL_ORDER_GATE_BLOCK_TIME = 1786060800;
function isMeteringEvalOrderActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= METERING_EVAL_ORDER_GATE_BLOCK_TIME;
}

// Coordinated activation for size-metering call/new/method argument spread
// (f(...x), new C(...x), arr.push(...x)). The AST metering transform rebuilds such
// argument lists through the size-charged __arrspread helper so the O(n) element
// copy is billed by count; the legacy transform left the spread unmetered (a flat
// __gas(1) per call), so a loop of bounded calls copied millions of elements almost
// free. CORRECTING it changes gasUsed for any contract using argument spread, so the
// rewrite is gated: post-gate meterCode emits the __arrspread-wrapped argument list,
// pre-gate it emits the call verbatim so historical blocks replay byte-identically.
// Gated like the other 2.0.0 contract-era changes: testnet/regtest from genesis,
// mainnet at the shared coordinated flag-day. Same coordinated timestamp as
// METERING_EVAL_ORDER/STATE_KEY_NUL/BINARY_ALLOC/ASYNC_SURFACE; a value that differs
// across the fleet is itself a fork.
const CALL_SPREAD_METER_GATE_BLOCK_TIME = 1786060800;
function isCallSpreadMeterActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= CALL_SPREAD_METER_GATE_BLOCK_TIME;
}

// Coordinated activation for size-metering destructuring REST patterns
// (`var [x, ...c] = a`, `var {k, ...c} = o`, and their assignment-expression forms),
// plus the deploy rejection of the rest positions metering cannot reach.
//
// This is the CALL_SPREAD_METER hole one AST dispatch away. transformAllocators
// dispatched purely on EXPRESSION node types (ArrayExpression/ObjectExpression carrying
// a SpreadElement), but a destructuring rest is an ArrayPattern/ObjectPattern carrying a
// RestElement, so it matched nothing and performed an unbounded native O(n) copy for a
// flat __gas(1). A loop of `var [...c] = bigArr` therefore copied millions of elements
// almost free: native CPU decoupled from gas, and a run's success-vs-wall-clock-timeout
// became CPU-speed dependent across the fleet. Post-gate the transform wraps the rest
// SOURCE in the size-charged __arrspread / __objspreadmeter helper; pre-gate the
// destructure is emitted verbatim so historical blocks replay byte-identically.
//
// !! IT DOES NOT RIDE THE CONTRACT-ERA FLAG DAY. 1786060800 (2026-08-07) is already in
// the PAST, so reusing it would retroactively re-price every rest destructure that has
// already executed and rewrite settled gasUsed on any replay -- the exact retroactivity
// the LINT_GLOBAL_ALIAS epoch was minted to avoid. It gets its own FUTURE instant, armed
// alongside the already-scheduled CROSS_CHAIN_ROYALTY flag day (2027-01-01 00:00:00 UTC)
// so the fleet has one coordination event rather than two. It is therefore deliberately
// NOT part of the six-gate CONTROLLER_GUARD cross-repo pin; its indexer twin is the
// REST_PATTERN_METER entry in protocol_changes.js, which the consensus-params suites in
// both repos pin to equality. A value that differs across the fleet is itself a fork.
const REST_PATTERN_METER_GATE_BLOCK_TIME = 1798761600;
function isRestPatternMeterActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= REST_PATTERN_METER_GATE_BLOCK_TIME;
}

// Activation for metering the native work the other size charges miss: iterator
// helpers (toArray, drop), String isWellFormed/toWellFormed, the Set algebra family
// and Function.prototype.apply with a long argument list. Every one moves gasUsed,
// so it is gated. Mainnet and
// testnet are unarmed (null) until a release cut schedules an instant; regtest runs
// the rule from genesis. Unknown or missing networks resolve like mainnet.
const ITER_SET_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: null,
    regtest: 0,
});
function isIterSetMeterActive(network, blockTime) {
    const gate = ITER_SET_METER_ACTIVATION[network];
    if (!Number.isFinite(gate)) return false;
    return gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate);
}

// Activation for the contract.slash `token` wire-delimiter guard. Every
// other emit validator rejects a '|' in a field the indexer may pipe-join;
// contract.slash never had that check. It is inert against today's consumer (SLASH
// is internal-only and processSlashEmission reads the params by named field), but
// a contract that slashes a '|'-bearing token currently SUCCEEDS and post-gate
// THROWS, which is consensus-visible, so the guard is gated like the other 2.0.0
// contract-era changes: testnet/regtest from genesis, mainnet at the shared
// coordinated flag-day. Deliberately rides the existing BINARY_ALLOC flag-day
// rather than minting a seventh constant (same choice as the F-MO math-output and
// F-PS proto-strip gateway gates), so the frozen six-gate consensus pin and its
// cross-repo CONTROLLER_GUARD check are untouched.
function isSlashTokenDelimGuardActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
}

// Token-decimal ceiling a contract.slash amount may carry post-activation. MUST equal
// the indexer's MAX_TOKEN_DECIMALS (xchain-indexer/src/config/token_limits.js); a divergent
// value would let the VM emit an amount the slash arithmetic cannot represent. Declared in
// gateway/slash_limits.js, which also builds the gateway's amount regex from it.
const { MAX_SLASH_AMOUNT_DECIMALS } = require('../../gateway/slash_limits.js');

// Activation for widening the contract.slash `amount` precision ceiling from 8 to
// MAX_SLASH_AMOUNT_DECIMALS. The 8-dp regex contradicted the other side of the same
// seam: STAKE v3 admits a stake at the token's own DECIMALS (up to 18) and
// slashContractStake computes the deduction at that precision, so an exact partial
// slash of a 9-18-dp staked token threw at the gateway and graduated slashing was
// impossible for exactly the tokens the any-token staking API accepts. RELAXING a
// check is as consensus-visible as tightening one (a call that threw now emits), so
// it is gated like its sibling above: testnet/regtest from genesis, mainnet at the
// shared coordinated flag-day, riding the existing BINARY_ALLOC flag-day rather than
// minting a new constant, so the frozen six-gate consensus pin is untouched.
function isSlashAmountPrecisionActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
}

// Activation for the CONSENSUS wall-clock budget per execution
// (CONSENSUS_MAX_WALL_MS, ./consensus-wall-clock.js). Below this gate the
// wall-clock net is the per-NODE limits.maxCpuTimeMs, which is not a consensus
// value: two validators configured differently return DIFFERENT statuses and
// DIFFERENT gasUsed for the same execution (timeout + gasUsed clamped to the
// ceiling on the tighter node, a committed success with its real gasUsed on the
// looser one), so an operator's config file could fork the fleet on any shape
// whose wall time outruns its gas. At/after the gate every node runs the same
// budget and the knob no longer binds a consensus execution. Gated like its
// siblings: testnet/regtest from genesis, mainnet (and unknown networks,
// conservative) at the shared coordinated flag-day, riding the existing
// BINARY_ALLOC flag-day rather than minting an eighth constant, so the frozen
// six-gate consensus pin and its cross-repo CONTROLLER_GUARD check are
// untouched. Pinning the bound AT the fleet's documented default (30000) is
// what makes riding an already-ratified flag-day safe: no execution on a
// default-configured node changes outcome, so there is no history to preserve
// below the gate. TIGHTENING the value later is a different change and needs
// its own future flag-day (see consensus-wall-clock.js).
//
// NOTE for a future reader: three comments inside HARNESS_SOURCE (the F3-globals,
// Set/Map and TypedArray metering notes) still describe maxCpuTimeMs as "the
// binding constraint" and "not a consensus value". They are deliberately left
// byte-identical: HARNESS_SOURCE is concatenated ahead of the contract before
// compilation, so editing a comment in it shifts every in-isolate line number and
// with it the positions V8 reports in error text a contract can read. Their
// cheap-gas/expensive-CPU point still stands; only the "per-node" half of it is
// superseded here.
function isConsensusWallClockActive(network, blockTime) {
    if (network === 'testnet' || network === 'regtest') return true;
    return Number.isFinite(blockTime) && blockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
}


module.exports = {
    ...require('./activation_heights.js'),
    MAX_SLASH_AMOUNT_DECIMALS,
    BINARY_ALLOC_GATE_BLOCK_TIME,
    JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME,
    JSON_STRINGIFY_HOOK_ACTIVATION,
    jsonStringifyHookGateTime,
    ASYNC_SURFACE_GATE_BLOCK_TIME,
    isAsyncSurfaceActive,
    VM_LINT_HARDENING_GATE_BLOCK_TIME,
    isLintHardeningActive,
    STATE_KEY_NUL_GATE_BLOCK_TIME,
    isStateKeyNulRejectActive,
    STATE_KEY_TYPE_GATE_BLOCK_TIME,
    isStateKeyTypeNormalizeActive,
    METERING_EVAL_ORDER_GATE_BLOCK_TIME,
    isMeteringEvalOrderActive,
    CALL_SPREAD_METER_GATE_BLOCK_TIME,
    isCallSpreadMeterActive,
    REST_PATTERN_METER_GATE_BLOCK_TIME,
    isRestPatternMeterActive,
    ITER_SET_METER_ACTIVATION,
    isIterSetMeterActive,
    isSlashTokenDelimGuardActive,
    isSlashAmountPrecisionActive,
    isConsensusWallClockActive,
};
