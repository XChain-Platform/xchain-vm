// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Wall time per execution is a CONSENSUS quantity: gas alone does not bound
// it, since native shapes exist whose wall-time-per-gas exceeds the
// schedule's assumption, and for those the wall-clock net terminates the
// execution. At/after the flag-day every node enforces the same protocol
// budget rather than a per-node config value; the knob binds ungated
// executions only, and the watchdog can never fire before that budget.

'use strict';

const assert = require('assert');
const wallClock = require('../../src/consensus-wall-clock.js');

let XChainVM = null;
try {
    XChainVM = require('../../src/index.js'); // requires isolated-vm (Node 22 / Linux)
} catch (e) { /* isolate-dependent blocks skip below */ }

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// The ratified 2.0.0 flag-day this gate rides (BINARY_ALLOC_GATE_BLOCK_TIME).
const FLAG_DAY = 1786060800;

describe('consensus wall-clock budget: the value and the resolver', function () {

    it('CONSENSUS_MAX_WALL_MS is the pinned protocol budget (a divergent value forks the fleet)', function () {
        // Pinned AT the fleet's documented default so promoting it to a protocol
        // constant changed no default-configured node's outcome. Tightening it is a
        // consensus tightening: new future flag-day, re-goldened determinism
        // baselines, atomic fleet deploy. Never edit it to make a slow box pass.
        assert.strictEqual(wallClock.CONSENSUS_MAX_WALL_MS, 30000);
    });

    it('resolveWallClockBudgetMs returns the protocol budget when gated, the node knob when not', function () {
        assert.strictEqual(wallClock.resolveWallClockBudgetMs(true, 1), 30000);
        assert.strictEqual(wallClock.resolveWallClockBudgetMs(true, 999999), 30000);
        assert.strictEqual(wallClock.resolveWallClockBudgetMs(false, 1), 1);
        assert.strictEqual(wallClock.resolveWallClockBudgetMs(false, 5000), 5000);
    });

    (XChainVM ? it : it.skip)('the VM re-exports the budget and the resolver', function () {
        assert.strictEqual(XChainVM.CONSENSUS_MAX_WALL_MS, wallClock.CONSENSUS_MAX_WALL_MS);
        assert.strictEqual(typeof XChainVM.isConsensusWallClockActive, 'function');
    });

    (XChainVM ? it : it.skip)('activation mirrors its sibling gates (pre-launch nets from genesis, mainnet at the flag-day)', function () {
        const active = XChainVM.isConsensusWallClockActive;
        assert.strictEqual(active('regtest', 0), true, 'regtest activates at genesis');
        assert.strictEqual(active('testnet', 0), true, 'testnet activates at genesis');
        assert.strictEqual(active('mainnet', FLAG_DAY), true, 'mainnet activates AT the flag-day');
        assert.strictEqual(active('mainnet', FLAG_DAY + 1), true);
        assert.strictEqual(active('mainnet', FLAG_DAY - 1), false, 'below the flag-day the knob still binds');
        // An unknown/empty network and a missing or garbage block time are treated
        // like mainnet below the flag-day: conservative, never accidentally active.
        assert.strictEqual(active(undefined, undefined), false);
        assert.strictEqual(active('', NaN), false);
        assert.strictEqual(active('mainnet', 'not-a-time'), false);
    });
});

(XChainVM ? describe : describe.skip)('consensus wall-clock budget: the enforcing path', function () {

    const CEILING = 1000000;

    function makeVM(maxCpuTimeMs) {
        return new XChainVM({
            gasSchedule: GAS_SCHEDULE,
            gasCeiling: CEILING,
            execution: 'in-process',
            limits: {
                maxCpuTimeMs: maxCpuTimeMs, maxMemory: 8, maxEmissions: 50,
                maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
            }
        });
    }

    const GATED   = { network: 'regtest', blockContext: { height: 1, timestamp: 1700000000, hash: 'h' } };
    const UNGATED = { network: 'mainnet', blockContext: { height: 1, timestamp: FLAG_DAY - 1, hash: 'h' } };

    it('a gated execution runs against the protocol budget, whatever the node configured', function () {
        // The whole point: three nodes, three configs, ONE budget. A divergent
        // budget is a divergent status and a divergent gasUsed for the same shape.
        for (const knob of [1, 1500, 5000, 30000, 120000]) {
            assert.strictEqual(makeVM(knob)._wallClockBudgetMs(GATED),
                wallClock.CONSENSUS_MAX_WALL_MS,
                'node knob ' + knob + ' must not bind a consensus execution');
        }
    });

    it('an ungated execution still runs against the node knob (replay parity + non-consensus callers)', function () {
        assert.strictEqual(makeVM(1500)._wallClockBudgetMs(UNGATED), 1500);
        assert.strictEqual(makeVM(500)._wallClockBudgetMs({ network: 'mainnet' }), 500);
        // No opts at all (bench/simulator style call) is ungated, not a crash.
        assert.strictEqual(makeVM(500)._wallClockBudgetMs(undefined), 500);
    });

    it('the timeout classifier corroborates against the SAME budget the isolate enforced', function () {
        // A node whose knob is looser than the protocol budget used to refuse to
        // recognise its own timeout: the isolate stopped at the budget, the
        // classifier compared elapsed against the bigger knob, and the execution
        // fell through to a generic 'error:' with an UNCLAMPED gasUsed while every
        // other validator recorded 'timeout:' with gasUsed = ceiling.
        const vm = makeVM(120000);
        const tracker = { used: 777, ceiling: CEILING, getUsed: () => 777 };
        const collector = { getLogs: () => [] };
        const signals = (over) => Object.assign({
            runStartNs: process.hrtime.bigint(),
            getIsolate: () => ({ isDisposed: false }),
            wallBudgetMs: vm._wallClockBudgetMs(GATED)
        }, over);

        const elapsedPastBudget = signals({
            runStartNs: process.hrtime.bigint() -
                BigInt(wallClock.CONSENSUS_MAX_WALL_MS + 5) * 1000000n
        });
        const real = vm._classifyError(new Error('Script execution timed out.'), tracker,
            collector, GATED, { reverted: false }, elapsedPastBudget);
        assert.ok(real.error.startsWith('timeout:'), real.error);
        assert.strictEqual(real.gasUsed, CEILING, 'a timeout charges the ceiling on every node');

        // Corroboration still bites: a contract-authored lookalike message with no
        // elapsed wall clock behind it is NOT a timeout and keeps its real gasUsed.
        const spoofed = vm._classifyError(new Error('Script execution timed out.'), tracker,
            collector, GATED, { reverted: false }, signals());
        assert.ok(spoofed.error.startsWith('error: '), spoofed.error);
        assert.strictEqual(spoofed.gasUsed, 777);
    });

    it('end to end: the SAME node config times the contract out ungated and completes it gated', async function () {
        // The falsifiable pair. One VM, one contract, one 1 ms knob: below the gate
        // the knob binds and the execution dies on the wall-clock net; at/after the
        // gate the protocol budget binds and the same execution commits. If the
        // enforcing path ever reads limits.maxCpuTimeMs again, the gated arm goes
        // red here rather than silently reintroducing a per-node fork surface.
        this.timeout(30000);
        const CODE = 'module.exports = function(xchain) { var s = 0;' +
                     ' for (var i = 0; i < 200000; i++) s += i; return s; };';
        const run = async (ctx) => {
            const vm = makeVM(1);
            vm.beginBlock();
            const r = await vm.execute({
                code: CODE, state: {}, method: 'default', params: [], caller: 'test_addr',
                contractAddress: 'C:BTC:1', contractIndex: 1, txHash: '00'.repeat(32),
                network: ctx.network, blockContext: ctx.blockContext,
                balances: {}, tokenInfo: {}
            });
            vm.endBlock();
            return r;
        };

        const ungated = await run(UNGATED);
        assert.strictEqual(ungated.success, false, 'a 1 ms node knob must still bind below the gate');
        assert.ok(ungated.error.startsWith('timeout:'), ungated.error);

        const gated = await run(GATED);
        assert.strictEqual(gated.success, true, gated.error);
    });
});

describe('consensus wall-clock budget: the subprocess watchdog cannot pre-empt it', function () {

    // The watchdog is a belt over the in-isolate bound. Armed off a knob TIGHTER
    // than the consensus budget it fires first, SIGKILLs the worker, and the parent
    // returns 'out_of_resource: execution host terminated' where every other
    // validator returned the contract's real result: the operator-configurable fork,
    // one layer up from the isolate.
    const ProcessExecutor = require('../../src/process-executor.js');
    const executors = [];

    function watchdogFor(maxCpuTimeMs) {
        const exec = new ProcessExecutor({
            gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000,
            limits: { maxCpuTimeMs: maxCpuTimeMs, maxMemory: 8, maxEmissions: 50 }
        });
        executors.push(exec);
        return exec._watchdogMs;
    }

    after(async function () {
        this.timeout(20000);
        for (const exec of executors) { try { await exec.shutdown(); } catch (e) { /* torn down */ } }
    });

    it('a knob tighter than the protocol budget still arms the belt ABOVE the budget', function () {
        this.timeout(20000);
        assert.ok(watchdogFor(1500) > wallClock.CONSENSUS_MAX_WALL_MS,
            'a 1500 ms knob must not arm a watchdog inside the consensus budget');
        assert.ok(watchdogFor(1) > wallClock.CONSENSUS_MAX_WALL_MS);
    });

    it('a knob looser than the protocol budget may still widen the belt', function () {
        this.timeout(20000);
        assert.ok(watchdogFor(120000) > 120000,
            'the belt stays above whatever budget the isolate could actually enforce');
    });
});
