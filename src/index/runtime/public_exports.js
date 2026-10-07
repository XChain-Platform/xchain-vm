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
 * XChain VM: public statics
 *
 * The constants, activation carriers and frozen re-exports attached to the
 * XChainVM constructor, in the order the entry always exported them
 * (src/toolkit/simulator.js reads that order).
 ********************************************************************/
// @ts-nocheck

const { CONSENSUS_MAX_WALL_MS } = require('../../consensus-wall-clock.js');
const {
    MAX_CODE_SIZE, MAX_CALL_DEPTH, MIN_CALL_GAS, MAX_STACK_DEPTH, MAX_STACK_DEPTH_MUSL,
    XCALL_MIN_GAS, XCALL_MAX_GAS, XCALL_MAX_HOPS,
    XCALL_MIN_DEADLINE_BLOCKS, XCALL_MAX_DEADLINE_BLOCKS, XCALL_MAX_RETURN_BYTES,
} = require('../constants.js');
const { LINT_OPTIONAL_CHAIN_ACTIVATION, isLintOptionalChainActive } = require('../lint_optional_chain_heights.js');
const {
    MAX_SLASH_AMOUNT_DECIMALS, BINARY_ALLOC_GATE_BLOCK_TIME, JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME,
    JSON_STRINGIFY_HOOK_ACTIVATION, jsonStringifyHookGateTime, ASYNC_SURFACE_GATE_BLOCK_TIME,
    isAsyncSurfaceActive, VM_LINT_HARDENING_GATE_BLOCK_TIME, isLintHardeningActive,
    STATE_KEY_NUL_GATE_BLOCK_TIME, STATE_KEY_TYPE_GATE_BLOCK_TIME,
    METERING_EVAL_ORDER_GATE_BLOCK_TIME, CALL_SPREAD_METER_GATE_BLOCK_TIME,
    REST_PATTERN_METER_GATE_BLOCK_TIME, isRestPatternMeterActive, isSlashTokenDelimGuardActive,
    ITER_SET_METER_ACTIVATION, isIterSetMeterActive, isSlashAmountPrecisionActive,
    isConsensusWallClockActive, PKG3_SANDBOX_ACTIVATION,
    pkg3CoinFromAddress, isPkg3SandboxActive, EXEC_LINT_ACTIVATION, LINT_GLOBAL_ALIAS_ACTIVATION,
    isLintGlobalAliasActive, EXEC_LINT_GAS_BYTES_PER_UNIT, isExecLintActive,
} = require('./activations.js');
const consensusRuntime = require('../../consensus-runtime.js');
const { HostFaultError } = require('../../errors.js');
const sandbox = require('../../sandbox.js');
const lintCore = require('../../lint-core.js');

function attachHeightGates(target) {
    // Expose the canonical code-size cap so the cross-service regression suite can
    // assert it has not drifted from the protocol constant.
    target.MAX_CODE_SIZE = MAX_CODE_SIZE;
    // Cross-contract call protocol constants (canonical:
    // xchain-documentation/protocol/constants.js) for the same reason.
    target.MAX_CALL_DEPTH = MAX_CALL_DEPTH;
    target.MIN_CALL_GAS   = MIN_CALL_GAS;
    // Intra-contract recursion bound (deterministic in-isolate stack-depth limit).
    target.MAX_STACK_DEPTH = MAX_STACK_DEPTH;
    // Musl-safe recursion bound applied at/after the coordinated height window.
    target.MAX_STACK_DEPTH_MUSL = MAX_STACK_DEPTH_MUSL;
    // Package 3 VM-sandbox flag-day: the per-coin activation-height map + resolver + the
    // coin-from-address helper. Exposed so the consensus-params freeze guard can pin them
    // (a divergent height or predicate forks the fleet) and tests can mirror the
    // per-coin/network activation. See PKG3_SANDBOX_ACTIVATION / isPkg3SandboxActive.
    target.PKG3_SANDBOX_ACTIVATION = PKG3_SANDBOX_ACTIVATION;
    target.isPkg3SandboxActive = isPkg3SandboxActive;
    target.pkg3CoinFromAddress = pkg3CoinFromAddress;
    // Execute-time source-lint enforcement: the per-coin activation-height map,
    // its resolver, and the gas granularity. Exposed so the consensus-params freeze guards in
    // THIS repo and in xchain-indexer can pin them to equality across the twinned pair; a
    // height armed on one side only, or a divergent gas divisor, forks the fleet.
    target.EXEC_LINT_ACTIVATION = EXEC_LINT_ACTIVATION;
    target.isExecLintActive = isExecLintActive;
    target.EXEC_LINT_GAS_BYTES_PER_UNIT = EXEC_LINT_GAS_BYTES_PER_UNIT;
    // Lint global-alias refinement (sloppy-mode `this` + the globalThis self-reference chain
    // counted as global reads by banned-async / banned-wasm): the per-coin activation-height
    // map and its resolver. Twinned with the xchain-indexer registry row
    // `vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION` (src/protocol_changes/gates_3.js)
    // and pinned to equality by the consensus-params guards in both repos; arming one side
    // alone forks the deploy verdict.
    target.LINT_GLOBAL_ALIAS_ACTIVATION = LINT_GLOBAL_ALIAS_ACTIVATION;
    target.isLintGlobalAliasActive = isLintGlobalAliasActive;
    // Optional-chain lint activation, twinned with indexer registry row
    // `vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION`.
    target.LINT_OPTIONAL_CHAIN_ACTIVATION = LINT_OPTIONAL_CHAIN_ACTIVATION;
    target.isLintOptionalChainActive = isLintOptionalChainActive;
}

function attachTimeGates(target) {
    // Coordinated flag-day (block time) that activates the F3-binary allocation gas
    // metering fleet-wide. Exposed so the consensus-params freeze guard can pin it,
    // the value is consensus-critical (a divergent flag day forks the fleet).
    target.BINARY_ALLOC_GATE_BLOCK_TIME = BINARY_ALLOC_GATE_BLOCK_TIME;
    // JSON.stringify value-hook resolution flag day, exported for the
    // consensus-params freeze guard because a divergent value forks the fleet.
    // The network-aware map and resolver below are authoritative for execution.
    // Testnet is armed at block time 1791061097 (2026-10-03 20:58:17 UTC); mainnet stays unarmed.
    target.JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME = JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME;
    target.JSON_STRINGIFY_HOOK_ACTIVATION = JSON_STRINGIFY_HOOK_ACTIVATION;
    target.jsonStringifyHookGateTime = jsonStringifyHookGateTime;
    // Expose the iter/Set/apply meter map and resolver for tooling to read, so it derives arming.
    target.ITER_SET_METER_ACTIVATION = ITER_SET_METER_ACTIVATION;
    target.isIterSetMeterActive = isIterSetMeterActive;
    // Coordinated flag-day (block time) that activates the async/Promise contract
    // surface change (Promise strip + banned-async deploy rejection) fleet-wide.
    // Exposed so the consensus-params freeze guard can pin it; consensus-critical.
    target.ASYNC_SURFACE_GATE_BLOCK_TIME = ASYNC_SURFACE_GATE_BLOCK_TIME;
    // The resolver alongside it, exported like its three sibling predicates
    // (isLintHardeningActive, isPkg3SandboxActive, isLintGlobalAliasActive) so a
    // caller resolving the deploy-lint flag set for a block gets all four from here
    // rather than re-deriving one from the constant. Additive: no gate value, no
    // predicate body and no activation table moves with it.
    target.isAsyncSurfaceActive = isAsyncSurfaceActive;
    // Coordinated flag-day (block time) that activates NUL-byte state-key rejection
    // at the state-write boundary (H-5: a NUL-bearing state_key wedges the indexer's
    // block merkle root). Exposed so the consensus-params freeze guard can pin it;
    // consensus-critical.
    target.STATE_KEY_NUL_GATE_BLOCK_TIME = STATE_KEY_NUL_GATE_BLOCK_TIME;
    // Coordinated flag-day (block time) that activates spec-correct `obj[k] += rhs`
    // evaluation order in the metering transform (L-3: legacy order evaluates rhs
    // before reading obj[k]). Exposed so the consensus-params freeze guard can pin it;
    // consensus-critical.
    target.METERING_EVAL_ORDER_GATE_BLOCK_TIME = METERING_EVAL_ORDER_GATE_BLOCK_TIME;
    // Coordinated flag-day (block time) that activates size-metering of call/new/method
    // argument spread in the metering transform (legacy left the O(n) copy unmetered).
    // Exposed so the consensus-params freeze guard can pin it; consensus-critical.
    target.CALL_SPREAD_METER_GATE_BLOCK_TIME = CALL_SPREAD_METER_GATE_BLOCK_TIME;
    // Destructuring-rest metering + the deploy rejection of unmeterable rest positions.
    // Its own FUTURE flag-day (see the constant); consensus-visible, pinned by the
    // test/determinism/consensus_params.test/ freeze guard against the indexer's
    // REST_PATTERN_METER.
    target.REST_PATTERN_METER_GATE_BLOCK_TIME = REST_PATTERN_METER_GATE_BLOCK_TIME;
    target.isRestPatternMeterActive = isRestPatternMeterActive;
    // Coordinated flag-day (block time) that activates canonical string state keys
    // (String(key) normalization for primitives, deterministic rejection of
    // non-primitive keys) so the key-size/NUL/keyCount guards apply to every key.
    // Exposed so the consensus-params freeze guard can pin it; consensus-critical.
    target.STATE_KEY_TYPE_GATE_BLOCK_TIME = STATE_KEY_TYPE_GATE_BLOCK_TIME;
    // Coordinated flag-day (block time) that activates the VM_LINT_HARDENING
    // package (hardened deploy-linter rule set, control-binding closure wrapper,
    // corroborated error classifier). Exposed so the consensus-params freeze guard
    // can pin it; consensus-critical. The resolver is exported for the indexer/
    // tests to mirror the network-aware activation.
    target.VM_LINT_HARDENING_GATE_BLOCK_TIME = VM_LINT_HARDENING_GATE_BLOCK_TIME;
    target.isLintHardeningActive = isLintHardeningActive;
}

function attachCallLimits(target) {
    // CONSENSUS wall-clock budget per execution, and the resolver that says when it
    // binds. Exposed so the consensus-params freeze guard can pin the value (a node
    // running a different budget forks the fleet on the first execution that reaches
    // it) and so the indexer / a validator host can assert the VM it bundles enforces
    // the same bound it prices batch weights against.
    target.CONSENSUS_MAX_WALL_MS = CONSENSUS_MAX_WALL_MS;
    target.isConsensusWallClockActive = isConsensusWallClockActive;
    // Resolver for the contract.slash token wire-delimiter guard. No new
    // flag-day constant: it rides BINARY_ALLOC_GATE_BLOCK_TIME. Exported so tests and
    // the indexer can mirror the network-aware activation.
    target.isSlashTokenDelimGuardActive = isSlashTokenDelimGuardActive;
    // Resolver + ceiling for the contract.slash amount-precision widening. Also rides
    // BINARY_ALLOC_GATE_BLOCK_TIME rather than minting a constant. The ceiling is
    // exported so a test can pin it against the indexer's MAX_TOKEN_DECIMALS.
    target.isSlashAmountPrecisionActive = isSlashAmountPrecisionActive;
    target.MAX_SLASH_AMOUNT_DECIMALS    = MAX_SLASH_AMOUNT_DECIMALS;
    // Export the cross-chain call protocol limits so validator hosts can pin the
    // VM's bounds against the values they revalidate while processing emissions.
    target.XCALL_MIN_GAS             = XCALL_MIN_GAS;
    target.XCALL_MAX_GAS             = XCALL_MAX_GAS;
    target.XCALL_MAX_HOPS            = XCALL_MAX_HOPS;
    target.XCALL_MIN_DEADLINE_BLOCKS = XCALL_MIN_DEADLINE_BLOCKS;
    target.XCALL_MAX_DEADLINE_BLOCKS = XCALL_MAX_DEADLINE_BLOCKS;
    target.XCALL_MAX_RETURN_BYTES    = XCALL_MAX_RETURN_BYTES;
}

function attachFrozenSurface(target) {
    // Expose the pinned consensus runtime + checker so the indexer (and any
    // validator process bundling the VM) can gate the engine version it runs on.
        target.CONSENSUS_RUNTIME = consensusRuntime.PINNED;
    target.CONSENSUS_VERSION = consensusRuntime.CONSENSUS_VERSION;
    target.CONSENSUS_STATUS_TOKENS = consensusRuntime.CONSENSUS_STATUS_TOKENS;
    target.STATUS_ERROR_PREFIXES = consensusRuntime.STATUS_ERROR_PREFIXES;
    target.checkConsensusRuntime = consensusRuntime.checkConsensusRuntime;
    target.describeRuntimeMismatch = consensusRuntime.describeMismatch;
    // Expose HostFaultError so a host that cannot run contracts (permanently broken
    // subprocess executor) is recognisable by callers. They must HALT, not commit
    // a fabricated result that would fork the chain.
    target.HostFaultError = HostFaultError;
    // Expose the FROZEN deploy/execution contract surface so the consensus-params
    // freeze guards (VM determinism suite + indexer cross-repo coupling test) can
    // digest it: the sandbox strip set and the deploy validator's CONSENSUS_RULES.
    // Any change to either must bump CONSENSUS_VERSION + re-golden in lockstep.
    target.STRIPPED_GLOBAL_NAMES = sandbox.STRIPPED_GLOBAL_NAMES;
    target.CONSENSUS_RULES = lintCore.CONSENSUS_RULES;
    // The sandbox neuters more than the global deletes: prototype-method strips
    // (regex + locale/ICU), the prototype .constructor neuters, and the SafeMath
    // member whitelist are each consensus-critical surface. Expose them frozen so the
    // same guards digest them too; otherwise an edit to one of those lists changes
    // consensus behaviour without reddening anything.
    target.STRIPPED_PROTO_METHODS = sandbox.STRIPPED_PROTO_METHODS;
    target.NEUTERED_PROTO_CONSTRUCTORS = sandbox.NEUTERED_PROTO_CONSTRUCTORS;
    target.SAFE_MATH_MEMBERS = sandbox.SAFE_MATH_MEMBERS;
    // Fail loudly if any frozen export goes missing (e.g. an internal rename in
    // sandbox.js / lint-core.js). Without this, the re-export silently becomes
    // undefined and the cross-repo freeze guards that digest it would skip rather
    // than redden, defeating the whole point of the surface freeze.
    if(!target.STRIPPED_GLOBAL_NAMES)
        throw new Error('xchain-vm: sandbox.js no longer exports STRIPPED_GLOBAL_NAMES (frozen consensus surface)');
    if(!target.CONSENSUS_RULES)
        throw new Error('xchain-vm: lint-core.js no longer exports CONSENSUS_RULES (frozen consensus surface)');
    if(!target.STRIPPED_PROTO_METHODS)
        throw new Error('xchain-vm: sandbox.js no longer exports STRIPPED_PROTO_METHODS (frozen consensus surface)');
    if(!target.NEUTERED_PROTO_CONSTRUCTORS)
        throw new Error('xchain-vm: sandbox.js no longer exports NEUTERED_PROTO_CONSTRUCTORS (frozen consensus surface)');
    if(!target.SAFE_MATH_MEMBERS)
        throw new Error('xchain-vm: sandbox.js no longer exports SAFE_MATH_MEMBERS (frozen consensus surface)');

}

function attachStatics(target) {
    attachHeightGates(target);
    attachTimeGates(target);
    attachCallLimits(target);
    attachFrozenSurface(target);
}

module.exports = { attachStatics };
