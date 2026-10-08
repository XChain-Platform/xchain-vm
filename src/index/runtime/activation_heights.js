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
 * XChain VM: height-gated activations
 *
 * The per-coin block-height gates (sandbox bundle, execute-time lint, lint
 * global alias) and their resolvers.
 ********************************************************************/
// @ts-nocheck

// ----- Package 3 VM-sandbox flag-day: per-coin block-HEIGHT bundle gate -----
// ONE coordinated activation for the whole flag-day Package 3 VM-sandbox bundle, so
// every leg flips fleet-wide together under a single CONSENSUS_VERSION bump (2 -> 3)
// and re-golden. Legs behind this gate:
//   - the musl-safe recursion bound, folded in here from its own gate;
//   - the WebAssembly global strip (75190596);
//   - the generator-function deploy ban (29912bd8).
// (Add legs as they land; a single gate keeps the whole bundle calendar-coherent.)
//
// Keyed on block HEIGHT, PER COIN, unlike the six 2.0.0 contract-era gates (all
// block-TIME at the 1786060800 flag-day). It rides the BTC-anchored ~961000 Cohort-B
// deploy window (the height the stake-weighted-quorum / anchor-reward /
// equivocation-header activations flip on, protocol/constants.js). A single bare
// mainnet 961000 is a BTC height; LTC (~3.1M tip) and DOGE (~6.3M tip) mainnet are
// already far past it, so a bare 961000 would be active-on-deploy on those chains
// and violate byte-identical-below there. Follow the STATE_COMMITMENT_ACTIVATION
// per-coin map template (xchain-indexer/src/state_commitment_activation.js):
// '<COIN>:mainnet' key, each coin's height the calendar equivalent of BTC 961000
// (~2026-08-04). testnet/regtest activate from genesis (no pre-activation history to
// preserve); an unknown network/coin or non-finite height resolves to pre-activation
// (legacy behaviour), the byte-identical-replay-safe default. Real callers always
// supply network + a resolvable C:<COIN>:<idx> contract address, so the fallback
// only ever affects malformed/test contexts.
//
// !! PROPOSED LTC/DOGE heights below AWAIT OPERATOR RATIFICATION at train sign-off.
// Arithmetic (tips measured 2026-07-22; BTC target 961000 = tip 959175 + 1825 blocks
// x 10 min = 18250 min ~= 12.67 days ~= 2026-08-04):
//   LTC:  tip 3146964 + (18250 min / 2.5 min-per-block = 7300 blocks)  = 3154264 -> 3154250
//   DOGE: tip 6300766 + (18250 min / 1.0 min-per-block = 18250 blocks) = 6319016 -> 6319000
const PKG3_SANDBOX_ACTIVATION = Object.freeze({
    'BTC:mainnet':  961000,     // the Cohort-B anchor (unchanged)
    'LTC:mainnet':  3154250,    // RATIFIED 2026-07-22 (pre-961000 train manifest)
    'DOGE:mainnet': 6319000,    // RATIFIED 2026-07-22 (pre-961000 train manifest)
});

// Derive the COIN from a 'C:<COIN>:<action_index>' contract address (the indexer
// builds it as 'C:' + config.CHAIN + ':' + CONTRACT_ACTION_INDEX). The per-coin gate
// needs the coin, which the indexer does NOT pass as a discrete opt; deriving it here
// keeps the whole gate inside the VM (no indexer-side opts change). Returns null for
// an absent/malformed address -> unresolvable coin -> pre-activation (safe default).
function pkg3CoinFromAddress(contractAddress) {
    if (typeof contractAddress !== 'string') return null;
    const parts = contractAddress.split(':');
    return (parts.length >= 3 && parts[0] === 'C' && parts[1]) ? parts[1] : null;
}

// Whether the Package 3 VM-sandbox bundle is active for (network, coin) at
// blockHeight. testnet/regtest: genesis. mainnet: per-coin height threshold;
// an unrecognized NETWORK, an unresolvable coin, or a non-finite height -> inactive
// (legacy, byte-identical below).
//
// Resolve on the network actually passed, not a hardcoded ':mainnet'. The indexer's
// deploy-half twin (registry row `vm_deploy_lint_pkg3_activation.VM_DEPLOY_LINT_PKG3_ACTIVATION`
// in xchain-indexer/src/protocol_changes/gates_3.js) keys on
// '<COIN>:<network>' and resolves an unrecognized network to OFF, and the two halves
// are documented as one gate that must never open a window where a wasm-referencing
// contract deploys clean but has WebAssembly stripped from under it at execution.
// Keying on ':mainnet' here put the runtime half ON and the deploy half OFF for any
// network string outside {mainnet,testnet,regtest}. Mainnet resolves the same key as
// before, so mainnet/testnet/regtest history replays byte-identically; only the
// unrecognized-network case moves, and the indexer rejects those at boot.
function isPkg3SandboxActive(network, coin, blockHeight) {
    if (network === 'testnet' || network === 'regtest') return true;
    const b = Number(blockHeight);
    if (!Number.isFinite(b)) return false;
    const threshold = (coin != null) ? PKG3_SANDBOX_ACTIVATION[coin + ':' + network] : undefined;
    return (threshold !== undefined) && b >= threshold;
}

// ----- Execute-time consensus source-lint enforcement: per-coin block-HEIGHT gate -----
// Every consensus source-lint ban (banned-async, banned-generator, banned-wasm and the
// VM_LINT_HARDENING rule set) is enforced at DEPLOY time only: the indexer runs
// validateSyntax over the submitted source and records the verdict, then execute() meters
// and runs the PERSISTED code with no re-check. So a contract accepted before a ban
// activates keeps executing banned syntax forever afterwards, which is exactly the case
// the bans exist to close (a live banned-generator instance can still leak __stackDepth
// toward the cap; a live WebAssembly reference still has the strip applied under it on
// one side of the fleet and not the other).
//
// The remedy is to re-run validateSyntax at EXECUTE time against the bans active for THAT
// block, and fail the execution deterministically when the stored source no longer passes.
// That flips executions that pass the deploy-time check to failures, so it is consensus-visible in
// the strongest sense and MUST ride its own activation: the three existing gates cannot be
// reused (both 1786060800 block-time gates are already open on every network and the Pkg 3
// heights are in the past, so there would be nothing left to ride, and a from-genesis
// replay would rewrite settled history).
//
// Shape follows PKG3_SANDBOX_ACTIVATION exactly: keyed on block HEIGHT, PER COIN, with the
// coin derived from the C:<COIN>:<idx> contract address (pkg3CoinFromAddress), so the whole
// gate stays inside the VM and no indexer-side opts change is needed. testnet/regtest
// activate from genesis: both are pre-launch, both already enforce the same rule set at
// deploy from genesis, so every contract that exists there passes the execute-time check
// and the only observable change is the metered lint gas. An unknown network/coin or a
// non-finite height resolves to pre-activation (no check, no gas), the byte-identical-
// replay-safe default.
//
// !! MAINNET IS ARMED AT GENESIS. The operator ratified the MECHANISM on 2026-08-11
// (execute-time enforcement, verdict cached by the metering sha256 key, cost metered as
// gas) and ruled on 2026-09-09 that a mainnet gate which is identity on the indexed
// mainnet history arms at genesis instead of at a train height. This one qualifies:
// mainnet carries 0 contracts, 0 DEPLOY and 0 EXECUTE actions (measured 2026-09-09), so
// there is no stored source for the re-lint to reject and no execution whose gas the lint
// charge could move. A from-genesis OLD-vs-ON replay witness per chain is the proof. The
// height lives here AND in the xchain-indexer twin (registry row
// `vm_exec_lint_activation.VM_EXEC_LINT_ACTIVATION` in xchain-indexer/src/protocol_changes/gates_3.js),
// which the consensus-params suites in both repos pin to equality. Arming one side alone forks.
const EXEC_LINT_ACTIVATION = Object.freeze({
    'BTC:mainnet':  0,   // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 contracts, 0 DEPLOY, 0 EXECUTE, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
});

// ----- Deploy/execute lint global-alias refinement: per-coin block-HEIGHT gate -----
// The banned-async, banned-wasm and banned-math deploy rules are identifier-precise: they
// flag the bare `Promise` / `WebAssembly` / `Math` identifier and the single-hop
// `globalThis.X` spelling. Two other
// spellings read the SAME global binding and walked straight past all three rules:
//   - sloppy-mode `this`. Contract code is evaluated by the saved Function constructor in
//     global scope as sloppy-mode script, so top-level `this` IS globalThis and a plain
//     `f()` call hands a sloppy function body the same receiver; `this.WebAssembly` was
//     never matched.
//   - the global object's own `globalThis` self-reference, at any depth:
//     `globalThis.globalThis.Promise`, `globalThis['globalThis'].WebAssembly`,
//     `this.globalThis.Promise`. The old check compared node.object.name directly, so one
//     extra hop defeated it. banned-math read the same global object through its own
//     single-hop matcher (isMathObjectRef), so `this.Math.pow` and
//     `globalThis.globalThis.Math.log` evaded it the same way; its object leg now resolves
//     through isGlobalObjectRef under this same epoch.
// Closing both moves DEPLOY verdicts on error-severity CONSENSUS_RULES, so it must be
// height-gated: below the activation the rules resolve exactly as they historically did
// and a from-genesis replay reproduces the accepted verdict byte for byte.
//
// It CANNOT ride VM_LINT_HARDENING. That block-time gate (1786060800) is already open on
// every network, so reusing it would apply the tightened rules retroactively to contracts
// the chain has already accepted, rewriting settled history on any replay. It cannot ride
// PKG3_SANDBOX_ACTIVATION either: those heights are in the past. It needs a NEW epoch, so
// it gets one, shaped exactly like EXEC_LINT_ACTIVATION above (per-coin block HEIGHT, coin
// derived from the C:<COIN>:<idx> contract address, testnet/regtest genesis-active because
// both are pre-launch, unknown network/coin or non-finite height -> pre-activation).
//
// !! MAINNET IS ARMED AT GENESIS. The operator ruled on 2026-09-09 that a mainnet gate
// which is identity on the indexed mainnet history arms at genesis instead of at a train
// height. This one qualifies: mainnet carries 0 contracts and 0 DEPLOY actions (measured
// 2026-09-09), so there is no accepted deploy verdict the widened rules could
// retroactively reverse. A from-genesis OLD-vs-ON replay witness per chain is the proof.
// The height lives here AND in the xchain-indexer twin (registry row
// `vm_lint_global_alias_activation.VM_LINT_GLOBAL_ALIAS_ACTIVATION` in
// xchain-indexer/src/protocol_changes/gates_3.js), which the consensus-params
// suites in both repos pin to equality. Arming one side alone forks.
const LINT_GLOBAL_ALIAS_ACTIVATION = Object.freeze({
    'BTC:mainnet':  0,   // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history (0 contracts, 0 DEPLOY, measured 2026-09-09)
    'LTC:mainnet':  0,
    'DOGE:mainnet': 0,
});

// Whether the lint global-alias refinement is active for (network, coin) at blockHeight.
// testnet/regtest: genesis. mainnet: per-coin height threshold; an unrecognized network, an
// unresolvable coin, a non-finite height, or an UNARMED (null) per-coin entry all resolve to
// inactive (legacy, byte-identical below).
function isLintGlobalAliasActive(network, coin, blockHeight) {
    if (network === 'testnet' || network === 'regtest') return true;
    const b = Number(blockHeight);
    if (!Number.isFinite(b)) return false;
    const threshold = (coin != null) ? LINT_GLOBAL_ALIAS_ACTIVATION[coin + ':' + network] : undefined;
    // Number.isFinite rejects both the absent key (undefined) and the unarmed sentinel (null).
    if (!Number.isFinite(threshold)) return false;
    return b >= threshold;
}

// Gas granularity for the execute-time lint. validateSyntax spawns an ivm.Isolate for the
// V8 syntax check and then parses the source with acorn, so its cost scales with the source
// length; charging VM_COMPUTATION per 256 bytes (minimum one unit) keeps it on the same
// deterministic, source-derived basis as every other metered step. The charge is levied on
// EVERY post-activation execution, cache hit or miss, so the verdict cache can never move
// gasUsed. Changing this divisor changes gasUsed (-> contract_hash -> fee), so it is a
// coordinated consensus parameter, pinned by the consensus-params suite.
const EXEC_LINT_GAS_BYTES_PER_UNIT = 256;

// Whether execute-time source-lint enforcement is active for (network, coin) at
// blockHeight. testnet/regtest: genesis. mainnet: per-coin height threshold; an
// unrecognized network, an unresolvable coin, a non-finite height, or an UNARMED
// (null) per-coin entry all resolve to inactive (legacy, byte-identical below).
//
// Keyed on the network actually passed, matching the indexer twin (registry row
// `vm_exec_lint_activation.VM_EXEC_LINT_ACTIVATION` in xchain-indexer/src/protocol_changes/gates_3.js)
// and isPkg3SandboxActive above.
function isExecLintActive(network, coin, blockHeight) {
    if (network === 'testnet' || network === 'regtest') return true;
    const b = Number(blockHeight);
    if (!Number.isFinite(b)) return false;
    const threshold = (coin != null) ? EXEC_LINT_ACTIVATION[coin + ':' + network] : undefined;
    // Number.isFinite rejects both the absent key (undefined) and the unarmed sentinel (null).
    if (!Number.isFinite(threshold)) return false;
    return b >= threshold;
}


module.exports = {
    PKG3_SANDBOX_ACTIVATION,
    pkg3CoinFromAddress,
    isPkg3SandboxActive,
    EXEC_LINT_ACTIVATION,
    LINT_GLOBAL_ALIAS_ACTIVATION,
    isLintGlobalAliasActive,
    EXEC_LINT_GAS_BYTES_PER_UNIT,
    isExecLintActive,
};
