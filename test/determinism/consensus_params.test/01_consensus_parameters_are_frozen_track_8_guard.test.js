/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Consensus-parameter FREEZE guard (LAUNCH-PLAN track 8).
 *
 * The VM half of the frozen consensus surface: the declared CONSENSUS_VERSION,
 * the pinned runtime, and the status vocabulary. These are golden literals:
 * any drift reddens here, and a real change must bump CONSENSUS_VERSION + a new
 * golden in BOTH repos (the indexer asserts the bundled VM's version) and, post-
 * launch, a protocol_changes.js block-height activation.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const cr = require('../../../src/consensus_runtime.js');
const vm = require('../../../src/index.js');
const lintCore = require('../../../src/lint_core.js');
const metering = require('../../../src/metering.js');

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('BINARY_ALLOC_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The F3-binary ArrayBuffer/TypedArray byte-length gas charge activates
        // fleet-wide at this block time. It is hashed (gasUsed → contract_hash) and
        // drives the fee debit, so two nodes that disagree on the flag day diverge
        // on the first binary-allocating execution after the earlier of the two.
        // Pin it like any other consensus parameter; changing it is a coordinated
        // release-team event, NOT a silent edit. Matches the indexer's other 2.0.0
        // flag-day activations (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.BINARY_ALLOC_GATE_BLOCK_TIME, 1786060800);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('CONSENSUS_MAX_WALL_MS is the frozen per-execution wall-clock budget', function () {
        // Gas does not bound wall time: shapes exist whose wall-time-per-gas is far
        // above the schedule's assumption, and for those the wall-clock net is what
        // terminates the execution. While that net was the per-NODE
        // limits.maxCpuTimeMs, a validator with a tighter budget recorded
        // 'timeout:' + gasUsed clamped to the ceiling where a looser one committed
        // the real state changes and the real gasUsed. Both are consensus-visible,
        // so the budget is a consensus parameter and is pinned here; a node running
        // a different value forks the fleet on the first execution that reaches it.
        // Pinned AT the fleet's documented default so promoting it changed no
        // default-configured node's outcome; TIGHTENING it is a separate consensus
        // event (future flag-day + re-goldened baselines + atomic deploy).
        assert.strictEqual(vm.CONSENSUS_MAX_WALL_MS, 30000);
        assert.strictEqual(require('../../../src/consensus_wall_clock.js').CONSENSUS_MAX_WALL_MS,
            vm.CONSENSUS_MAX_WALL_MS, 'enforcing module and export must be the same value');
        // The activation rides the ratified 2.0.0 flag-day, like its siblings.
        assert.strictEqual(vm.isConsensusWallClockActive('regtest', 0), true);
        assert.strictEqual(vm.isConsensusWallClockActive('mainnet', vm.BINARY_ALLOC_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isConsensusWallClockActive('mainnet', vm.BINARY_ALLOC_GATE_BLOCK_TIME - 1), false);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('CALL_SPREAD_METER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Size-metering of call/new/method argument spread (the __arrspread-wrapped
        // argument list) activates fleet-wide at this block time on mainnet. It moves
        // gasUsed (→ contract_hash → fee debit), so two nodes that disagree on the flag
        // day diverge on the first spread-argument execution after the earlier of the
        // two. Pin it like any other consensus parameter; batched into the same 2.0.0
        // flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.CALL_SPREAD_METER_GATE_BLOCK_TIME, 1786060800);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('REST_PATTERN_METER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Size-metering of destructuring rest (the __arrspread/__objspreadmeter-wrapped
        // rest SOURCE) and the deploy rejection of the rest positions metering cannot
        // reach both activate fleet-wide at this block time on mainnet. It moves gasUsed
        // (→ contract_hash → fee debit) AND a deploy verdict, so two nodes that disagree
        // on the flag day diverge on the first rest-using execution or deploy after the
        // earlier of the two. Pin it like any other consensus parameter.
        //
        // It does NOT ride the contract-era flag-day, deliberately: 1786060800 is already
        // in the past, so reusing it would retroactively re-price rest destructures that
        // have already executed. It takes the next scheduled coordinated instant instead
        // (2027-01-01 00:00:00 UTC, shared with the indexer's CROSS_CHAIN_ROYALTY).
        assert.strictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, 1798761600);
        // testnet/regtest genesis-active; mainnet strictly at/after the instant.
        assert.strictEqual(vm.isRestPatternMeterActive('regtest', 0), true);
        assert.strictEqual(vm.isRestPatternMeterActive('testnet', 0), true);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', vm.REST_PATTERN_METER_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', vm.REST_PATTERN_METER_GATE_BLOCK_TIME - 1), false);
        // A missing/garbage timestamp must resolve PRE-gate on mainnet (replay-safe default).
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', NaN), false);
        assert.strictEqual(vm.isRestPatternMeterActive('mainnet', undefined), false);
        // And it must stay OFF the contract-era instant. If a future repin quietly folds it
        // into the six-gate batch below, every already-executed rest destructure is re-priced
        // retroactively -- which is exactly the retroactivity this separate arming exists to
        // prevent, so assert the separation rather than trusting the comment.
        assert.notStrictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, vm.CALL_SPREAD_METER_GATE_BLOCK_TIME,
            'REST_PATTERN_METER must keep its own FUTURE flag-day; the contract-era instant is in the past');
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('REST_PATTERN_METER_GATE_BLOCK_TIME matches the indexer REST_PATTERN_METER literal (cross-repo repin guard)', function () {
        // The VM constant and the indexer protocol_changes entry are the two halves of one
        // flag day: the VM gates the metering rewrite on it, the indexer gates the deploy
        // rejection on it (deploy/index.js enforceBannedRest). A repin that edits one and misses
        // the other passes BOTH CIs and forks the fleet at activation. Same construction as
        // the six-gate CONTROLLER_GUARD guard below; skips only when the sibling repo is
        // not checked out (standalone clone), where the hard pin above still holds.
        const path = require('path'), fs = require('fs');
        const indexerFile = path.resolve(__dirname, '../../../../xchain-indexer/src/protocol_changes.js');
        if (!fs.existsSync(indexerFile)) this.skip();
        const src = fs.readFileSync(indexerFile, 'utf8');
        const all = [...src.matchAll(/addChange\(\s*'REST_PATTERN_METER'\s*,\s*'[^']+'\s*,\s*(\d+)/g)];
        assert.strictEqual(all.length, 1,
            "expected exactly one REST_PATTERN_METER addChange in the indexer's protocol_changes.js, found " + all.length);
        assert.strictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, Number(all[0][1]),
            'REST_PATTERN_METER diverged between xchain-vm and xchain-indexer: a repin must move both in lockstep');
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('Package 3 VM-sandbox bundle gate: per-coin activation heights + depth bounds are frozen', function () {
        // The whole flag-day Package 3 VM-sandbox bundle flips on ONE per-coin
        // block-HEIGHT gate (the musl-safe recursion bound folded in, the
        // WebAssembly strip, the generator-fn ban). The activation heights and the
        // depth bounds are hashed-behaviour-affecting (they move which executions
        // out_of_stack / which globals strip), so pin them like any other consensus
        // parameter; a divergent height or predicate forks the fleet. Unlike the six
        // 2.0.0 gates this keys on block HEIGHT, PER COIN, riding the ~961000 window.
        assert.strictEqual(vm.MAX_STACK_DEPTH, 512, 'pre-activation bound is the legacy 512');
        assert.strictEqual(vm.MAX_STACK_DEPTH_MUSL, 256, 'post-activation musl-safe bound');
        // Per-coin activation-height map (LTC/DOGE mainnet PROPOSED, awaiting operator
        // ratification at train sign-off). A bare BTC 961000 would be active-on-deploy
        // on LTC/DOGE (tips already far past it); each coin gets its calendar-equiv height.
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['BTC:mainnet'], 961000);
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['LTC:mainnet'], 3154250);
        assert.strictEqual(vm.PKG3_SANDBOX_ACTIVATION['DOGE:mainnet'], 6319000);
        // coin derivation from the C:<COIN>:<idx> contract address.
        assert.strictEqual(vm.pkg3CoinFromAddress('C:BTC:1'), 'BTC');
        assert.strictEqual(vm.pkg3CoinFromAddress('C:DOGE:42'), 'DOGE');
        assert.strictEqual(vm.pkg3CoinFromAddress('garbage'), null);
        assert.strictEqual(vm.pkg3CoinFromAddress(undefined), null);
        // Per-coin/network resolver: testnet/regtest from genesis; each mainnet coin at
        // its own height; unresolvable coin or non-finite height -> pre-activation.
        assert.strictEqual(vm.isPkg3SandboxActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isPkg3SandboxActive('testnet', 'BTC', 0), true);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'BTC', 960999), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'BTC', 961000), true);
        // The per-coin fix: LTC/DOGE mainnet stay pre-activation at a bare BTC 961000.
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'LTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'LTC', 3154250), true);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'DOGE', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', 'DOGE', 6319000), true);
        // An unrecognized network resolves INACTIVE, the same direction as the indexer's
        // deploy-half twin (isVmDeployLintPkg3Active, pinned there for 'stagenet'). The
        // two halves are one gate: a network on which the runtime strip armed while the
        // deploy lint stayed off is the "deploys clean, stripped at runtime" window the
        // shared gate exists to prevent. Only mainnet/testnet/regtest ever reach a real
        // node, so this fixes the invariant by construction rather than by relying on
        // the indexer's boot-time network validation.
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive('stagenet', 'BTC', 961000), false);
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', 100), false);
        assert.strictEqual(vm.isPkg3SandboxActive(undefined, 'BTC', NaN), false);
        // unresolvable coin -> inactive (safe legacy default) even at a high height.
        assert.strictEqual(vm.isPkg3SandboxActive('mainnet', null, 10000000), false);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('execute-time source-lint gate: per-coin map is ARMED AT GENESIS on mainnet and the gas divisor is frozen', function () {
        // Re-linting stored contract code at EXECUTE time flips executions that pass the
        // deploy-time check into failures and adds a source-length-derived gas charge, so both
        // the activation heights and the gas divisor are consensus parameters: a node
        // that armed a different height, or charged on a different divisor, forks on the
        // first execution of an affected contract.
        //
        // The operator ratified the MECHANISM on 2026-08-11 and ruled on 2026-09-09 that
        // a gate which is identity on the indexed mainnet history arms at genesis. This
        // one is: mainnet carries 0 contracts, 0 DEPLOY and 0 EXECUTE actions (measured
        // 2026-09-09), so height 0 rejects nothing and moves no gas. This assertion is
        // what makes a DISARMING or a divergent height visible: moving it is a
        // deliberate, reviewed edit that must move the xchain-indexer twin
        // (src/vm_exec_lint_activation.js) in the SAME change.
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['BTC:mainnet'], 0);
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['LTC:mainnet'], 0);
        assert.strictEqual(vm.EXEC_LINT_ACTIVATION['DOGE:mainnet'], 0);
        assert.strictEqual(vm.EXEC_LINT_GAS_BYTES_PER_UNIT, 256);
        // Armed at genesis means active at EVERY mainnet height from 0 up, including
        // absurd ones: there is no pre-activation window left on mainnet.
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', 0), true);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', 961000), true);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'LTC', 10000000), true);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'DOGE', Number.MAX_SAFE_INTEGER), true);
        // Unknown network is treated as mainnet (conservative), unknown coin resolves off.
        assert.strictEqual(vm.isExecLintActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', 'XYZ', 961000), false);
        assert.strictEqual(vm.isExecLintActive('mainnet', null, 961000), false);
        // Pre-launch nets are genesis-active: they already enforce the identical rule set
        // at deploy from genesis, so nothing that exists there can fail the execute check.
        assert.strictEqual(vm.isExecLintActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isExecLintActive('testnet', 'DOGE', 0), true);
        // A non-finite height is pre-activation even on a genesis-active-by-height chain.
        assert.strictEqual(vm.isExecLintActive('mainnet', 'BTC', NaN), false);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('lint global-alias gate: per-coin map is ARMED AT GENESIS on mainnet and cannot ride an open gate', function () {
        // Widening banned-async / banned-wasm to the aliased global reads (sloppy-mode
        // `this`, the globalThis self-reference chain) changes which contracts the chain
        // ACCEPTS, so the activation heights are consensus parameters exactly like the
        // exec-lint ones above: a node that armed a different height rejects a deploy its
        // peers accept, and a from-genesis replay rewrites settled verdicts.
        //
        // Mainnet arms at genesis by the 2026-09-09 ruling: the indexed mainnet history
        // carries 0 contracts and 0 DEPLOY actions (measured 2026-09-09), so there is no
        // accepted deploy verdict the widened rules can reverse. Moving this height is a
        // deliberate, reviewed edit that must move the xchain-indexer twin
        // (src/vm_lint_global_alias_activation.js) in the SAME change; that repo's suite
        // pins the pair to equality.
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['BTC:mainnet'], 0);
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['LTC:mainnet'], 0);
        assert.strictEqual(vm.LINT_GLOBAL_ALIAS_ACTIVATION['DOGE:mainnet'], 0);
        assert.ok(Object.isFrozen(vm.LINT_GLOBAL_ALIAS_ACTIVATION));
        // Armed at genesis means active at EVERY mainnet height from 0 up.
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 0), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 961000), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'DOGE', Number.MAX_SAFE_INTEGER), true);
        // Unknown network / coin / height resolve pre-activation (safe legacy default).
        assert.strictEqual(vm.isLintGlobalAliasActive(undefined, 'BTC', 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'XYZ', 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', null, 961000), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', NaN), false);
        // Pre-launch nets are genesis-active (no accepted history to preserve).
        assert.strictEqual(vm.isLintGlobalAliasActive('regtest', 'BTC', 0), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('testnet', 'DOGE', 0), true);
        // It is a DISTINCT epoch, not a rider on VM_LINT_HARDENING. Both are open on
        // mainnet now, so equality of the two verdicts no longer separates them; what
        // still does is the axis each reads. VM_LINT_HARDENING is a coin-blind BLOCK-TIME
        // gate that is shut below 1786060800, while this one is a per-coin BLOCK-HEIGHT
        // gate open from 0, so they disagree at time 0 / height 0. That disagreement is
        // what reddens if someone "simplifies" the new gate away onto the old one.
        assert.strictEqual(vm.isLintHardeningActive('mainnet', vm.VM_LINT_HARDENING_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isLintHardeningActive('mainnet', 0), false);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'BTC', 0), true);
        // And the height gate stays coin-keyed: an unknown coin resolves off where the
        // coin-blind time gate would have said yes.
        assert.strictEqual(vm.isLintHardeningActive('mainnet', vm.VM_LINT_HARDENING_GATE_BLOCK_TIME), true);
        assert.strictEqual(vm.isLintGlobalAliasActive('mainnet', 'XYZ', 961000), false);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('STATE_KEY_NUL_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Rejecting NUL-byte state keys flips an execution from success to failure
        // (hashed status + state delta), so two nodes that disagree on the flag day
        // diverge on the first NUL-key write after the earlier of the two. The
        // regression suite exercises the gate's BEHAVIOR relative to the export;
        // this is the hard VALUE pin (a rename/removal makes the export undefined
        // and fails here too). Same 2.0.0 flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.STATE_KEY_NUL_GATE_BLOCK_TIME, 1786060800);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('METERING_EVAL_ORDER_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The spec-correct obj[k] += rhs rewrite (__setconcatL) changes results and
        // gasUsed for side-effecting RHS patterns, so the activation must flip
        // fleet-wide at one timestamp. Hard value pin alongside its sibling gates;
        // batched into the same 2.0.0 flag-day (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.METERING_EVAL_ORDER_GATE_BLOCK_TIME, 1786060800);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('STATE_KEY_TYPE_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // Canonical string state keys (String(key) for primitives, deterministic
        // rejection of non-primitive keys) change which writes are valid and how
        // keys count against maxStateKeys, so the activation must flip fleet-wide
        // at one timestamp. Batched into the same 2.0.0 flag-day
        // (protocol_changes.js: 1786060800).
        assert.strictEqual(vm.STATE_KEY_TYPE_GATE_BLOCK_TIME, 1786060800);
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('all six gate constants match the indexer protocol_changes.js CONTROLLER_GUARD literal (cross-repo repin guard)', function () {
        // The six literal pins above freeze the VM's flag-day value, and the
        // indexer's own suite freezes its value, but nothing tied the two files
        // together: a coordinated repin that edits the indexer literal and misses
        // one VM constant passes BOTH CIs and forks the fleet at activation.
        // Read the indexer source directly (monorepo
        // sibling checkout) and assert every VM gate equals the CONTROLLER_GUARD
        // activation time. Skips only when the sibling repo is not checked out
        // (standalone clone); the hard value pins above still guard that case.
        const path = require('path'), fs = require('fs');
        const indexerFile = path.resolve(__dirname, '../../../../xchain-indexer/src/protocol_changes.js');
        if (!fs.existsSync(indexerFile)) this.skip();
        const src = fs.readFileSync(indexerFile, 'utf8');
        // The CONSENSUS_VERSION tier is matched as a wildcard because its label
        // belongs to the indexer's platform version stream. This guard couples the
        // repos through the flag-day timestamp, independent of a tier-only rename.
        const all = [...src.matchAll(/addChange\(\s*'CONTROLLER_GUARD'\s*,\s*'[^']+'\s*,\s*(\d+)/g)];
        assert.strictEqual(all.length, 1,
            "expected exactly one CONTROLLER_GUARD addChange in the indexer's protocol_changes.js, found " + all.length);
        const m = all[0];
        const indexerFlagDay = Number(m[1]);
        const gates = [
            'ASYNC_SURFACE_GATE_BLOCK_TIME', 'BINARY_ALLOC_GATE_BLOCK_TIME',
            'CALL_SPREAD_METER_GATE_BLOCK_TIME', 'STATE_KEY_NUL_GATE_BLOCK_TIME',
            'METERING_EVAL_ORDER_GATE_BLOCK_TIME', 'STATE_KEY_TYPE_GATE_BLOCK_TIME'
        ];
        for (const g of gates) {
            assert.strictEqual(vm[g], indexerFlagDay,
                g + ' diverged from the indexer CONTROLLER_GUARD flag-day: a repin must move all six VM gates and the indexer literal in lockstep');
        }
        // REST_PATTERN_METER_GATE_BLOCK_TIME is deliberately NOT in that list: the
        // contract-era instant is in the PAST, so riding it would retroactively re-price
        // rest destructures that have already executed. It is armed separately and pinned
        // to its own indexer twin by the cross-repo guard above.
        assert.ok(!gates.includes('REST_PATTERN_METER_GATE_BLOCK_TIME'));
        assert.notStrictEqual(vm.REST_PATTERN_METER_GATE_BLOCK_TIME, indexerFlagDay,
            'REST_PATTERN_METER must not be folded into the contract-era batch (that instant has passed)');
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('XCALL_MAX_HOPS is single-sourced from the emit-time enforcer and pinned', function () {
        // gateway_emit.js declares the hop cap it enforces (crossExecute's hop
        // gate) and index.js re-exports that same binding for the cross-service
        // parity suite. Pin both the value and the single-sourcing so a future
        // bump cannot leave the enforcer and the parity-tested export diverging.
        const gatewayEmit = require('../../../src/gateway_emit.js');
        assert.strictEqual(vm.XCALL_MAX_HOPS, 2);
        assert.strictEqual(gatewayEmit.XCALL_MAX_HOPS, vm.XCALL_MAX_HOPS,
            'gateway_emit enforcer and index.js export must be the same value');
    });
});

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('STATUS_ERROR_PREFIXES documents every raw prefix the VM can emit', function () {
        assert.deepStrictEqual(cr.STATUS_ERROR_PREFIXES,
            ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']);
        assert.ok(Object.isFrozen(cr.STATUS_ERROR_PREFIXES));
        // The whole resource-exhaustion family the indexer collapses to
        // 'out_of_resource' must be covered, plus the revert / generic prefixes.
        for (const p of ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']) {
            assert.ok(cr.STATUS_ERROR_PREFIXES.includes(p), 'missing prefix: ' + p);
        }
    });
});
