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
 * Out-of-process executor: the host-abort containment fix.
 *
 * Verifies that subprocess execution: (1) produces results identical to
 * in-process for normal contracts, (2) survives a contract that aborts the
 * V8 host process (the Array(1e8).fill bug) by returning a deterministic
 * resource failure and respawning, (3) carries plain-data snapshots across
 * the IPC boundary.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const XChainVM = require('../../src/index.js');
const { hashResult } = require('../fuzz/harness');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const LIMITS = {
    maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000,
    maxStateValueSize: 65536, maxCodeSize: 65536, maxStateKeySize: 1024, maxBlockCacheSize: 1000
};
const GAS_CEILING = 1000000;

function makeVM(execution) {
    return new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS, execution });
}

const BASE = {
    state: {}, method: 'default', params: [], caller: 'addr',
    contractAddress: 'C:BTC:1', contractIndex: 1,
    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
};

// Probe whether isolated-vm loads at all (skip cleanly if not).
let HAVE_IVM = true;
try { require('isolated-vm'); } catch (e) { HAVE_IVM = false; }

(HAVE_IVM ? describe : describe.skip)('process-executor: out-of-process execution', function () {
    this.timeout(60000);

    let vm;
    afterEach(async function () {
        if (vm) { await vm.shutdown(); vm = null; }
    });

    it('runs a normal contract and matches in-process output', async function () {
        const code = `module.exports = function(xchain){
            xchain.state.set('n', xchain.math.add(xchain.state.get('n') || '0', '5'));
            xchain.emit.send({ destination: 'D', tick: 'TEST', quantity: '5' });
            return 'ok';
        };`;
        const inproc = makeVM('in-process');
        inproc.beginBlock();
        const a = await inproc.execute({ ...BASE, code, state: { n: '37' } });
        inproc.endBlock();

        vm = makeVM('subprocess');
        vm.beginBlock();
        const b = await vm.execute({ ...BASE, code, state: { n: '37' } });
        vm.endBlock();

        assert.strictEqual(b.success, true, 'subprocess run should succeed: ' + b.error);
        // Compare via the consensus-equality function (sha256 of the normalized,
        // JSON-serialized result): the same hash the golden manifest uses. This
        // is prototype-agnostic, which is correct: consensus sees the JSON form,
        // not the in-memory object's prototype.
        assert.strictEqual(hashResult(b), hashResult(a),
            'subprocess output must be consensus-identical to in-process');
    });

    it('CONTAINS a host-aborting contract and keeps serving (respawn)', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();

        // A hostile bulk allocation. With F3 allocation metering it is charged by
        // size and hits the gas ceiling (out_of_gas) BEFORE V8 services it, so it no
        // longer aborts the worker; either way it is contained as a deterministic
        // resource failure at the ceiling and the executor keeps serving.
        const bomb = `module.exports = function(xchain){ var a = new Array(100000000).fill('x'); return a.length; };`;
        const r = await vm.execute({ ...BASE, code: bomb });

        assert.strictEqual(r.success, false, 'hostile allocation must fail');
        assert.match(r.error, /out_of_resource|out_of_memory|timeout|out_of_gas/,
            'must map to a deterministic resource failure, got: ' + r.error);
        assert.strictEqual(r.gasUsed, GAS_CEILING, 'must charge the gas ceiling (fork-safe fee)');

        // The executor must have respawned; a normal contract still works.
        const ok = await vm.execute({ ...BASE, code: `module.exports = function(){ return 'alive'; };` });
        assert.strictEqual(ok.success, true, 'executor should serve again after a crash: ' + ok.error);
        assert.strictEqual(ok.returnValue, '"alive"');
    });

    it('carries plain-data snapshots (oracle) across IPC', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();
        const code = `module.exports = function(xchain){ return xchain.oracle.getPrice('BTC/USD'); };`;
        const r = await vm.execute({
            ...BASE, code,
            oracleData: { snapshotAge: 3, prices: { 'BTC/USD': '65000.00' }, rounds: {} }
        });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"65000.00"', 'oracle snapshot should resolve over IPC');
    });

    it('survives several aborting contracts in a row without leaking', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();
        const bomb = `module.exports = function(){ var a = new Array(100000000).fill('x'); return a.length; };`;
        for (let i = 0; i < 3; i++) {
            const r = await vm.execute({ ...BASE, code: bomb });
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.gasUsed, GAS_CEILING);
        }
        const ok = await vm.execute({ ...BASE, code: `module.exports = function(){ return 1; };` });
        assert.strictEqual(ok.success, true, 'still serving after repeated crashes');
    });

    // F2 regression: deterministic dispatch after a worker death.
    //
    // The indexer runs contracts sequentially, so the contract IMMEDIATELY after one
    // that killed its worker must still run on the RESPAWNED worker and return
    // its real result on every validator. Before the ready-gated-dispatch fix, that
    // next contract could be sent to the dying worker (in the window after the
    // watchdog kills it but before 'exit'/respawn) and resolve as a host-termination
    // (SIGKILL) → a nondeterministic result for the following contract → fork.
    //
    // We exercise this at the EXECUTOR level (a contract can no longer reliably kill
    // the worker now that F3 gas-bounds bulk allocations): drive a worker death the
    // way the watchdog does: kill the child and mark it un-dispatchable
    // (_sawReady=false, exactly what the watchdog callback now sets), then dispatch
    // the next request. It MUST queue and run on the respawn, never be host-terminated.
    it('F2: executor queues+recovers the next request after a worker death', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        const job = (ret) => ({ ...BASE, code: `module.exports = function(){ return '${ret}'; };` });
        try {
            const r1 = await exec.execute(job('a'));
            assert.strictEqual(r1.returnValue, '"a"', 'baseline: executor serves');

            // Simulate the watchdog firing on an unresponsive worker.
            exec._child.kill('SIGKILL');
            exec._sawReady = false;

            const r2 = await exec.execute(job('b'));
            assert.strictEqual(r2.success, true,
                'a request issued during the kill→respawn window must run on the respawn, ' +
                'not be host-terminated: ' + r2.error);
            assert.strictEqual(r2.returnValue, '"b"');

            // And the executor keeps serving afterwards.
            const r3 = await exec.execute(job('c'));
            assert.strictEqual(r3.returnValue, '"c"');
        } finally {
            await exec.shutdown();
        }
    });

    // Halt-vs-fabricate: a PERMANENTLY broken executor (worker can never start)
    // must REJECT, not fabricate. Fabricating out_of_resource for work the fleet
    // runs would fork this node off the chain (a host fault is not a contract
    // property). The indexer turns the rejection into a halt-and-retry.
    it('host fault: a permanently-broken executor REJECTS with HostFaultError', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const { HostFaultError } = require('../../src/errors.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            // Permanent fault, inside the recovery backoff window → no spawn, host fault.
            exec._broken = true;
            exec._lastBrokenRetryAt = Date.now();
            await assert.rejects(
                exec.execute({ ...BASE, code: `module.exports = function(){ return 1; };` }),
                (e) => e instanceof HostFaultError && e.code === 'EXECUTOR_UNAVAILABLE',
                'a broken executor must reject (halt), not fabricate out_of_resource'
            );
        } finally {
            await exec.shutdown();
        }
    });

    it('host fault: a broken executor SELF-HEALS once the host recovers', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            // Broken, but the backoff has elapsed → execute() probes a fresh spawn,
            // which succeeds (the host is actually fine here) → the request runs.
            exec._broken = true;
            exec._lastBrokenRetryAt = 0;
            const r = await exec.execute({ ...BASE, code: `module.exports = function(){ return 'healed'; };` });
            assert.strictEqual(r.success, true, 'recovery probe should run the contract: ' + r.error);
            assert.strictEqual(r.returnValue, '"healed"');
            assert.strictEqual(exec._broken, false, '_broken must clear after a successful recovery');
        } finally {
            await exec.shutdown();
        }
    });

    // Watchdog must bound EXECUTION, not queue-wait + execution. Started at
    // acceptance it also counted time spent queued, so a validator whose queue
    // was backed up (many contracts in a block, slow disk, a respawn in
    // progress) fabricated out_of_resource for a contract every other
    // validator executed normally → divergent contract status → fork. A
    // request that waits in the queue for many watchdog windows must still
    // run and succeed once the worker is dispatchable.
    it('a queued request never times out on queue wait (watchdog starts at dispatch)', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            // Warm-up also guarantees the worker reached 'ready'.
            const r0 = await exec.execute({ ...BASE, code: `module.exports = function(){ return 'warm'; };` });
            assert.strictEqual(r0.returnValue, '"warm"');

            // Shrink the watchdog so queue wait spans several windows, then
            // hold dispatch closed (exactly the backed-up/respawning state).
            exec._watchdogMs = 250;
            exec._sawReady = false;

            const queued = exec.execute({ ...BASE, code: `module.exports = function(){ return 'queued'; };` });

            await new Promise((r) => setTimeout(r, 800));
            assert.strictEqual(exec._queue.length, 1,
                'request must still be queued after 3+ watchdog windows, not resolved');

            // Worker becomes dispatchable again → the contract must RUN.
            exec._sawReady = true;
            exec._flush();
            const r = await queued;
            assert.strictEqual(r.success, true,
                'queue wait must never produce out_of_resource (fork risk): ' + r.error);
            assert.strictEqual(r.returnValue, '"queued"');
        } finally {
            await exec.shutdown();
        }
    });

    // The dispatch-time watchdog still catches a genuinely stuck worker: a
    // dispatched request on a frozen child resolves the deterministic
    // resource-failure clamp and the executor recovers for subsequent work.
    it('the dispatch-time watchdog still kills a hung worker (deterministic clamp)', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            await exec.execute({ ...BASE, code: `module.exports = function(){ return 'warm'; };` });

            // Freeze (don't kill) the child so the next dispatch can never
            // complete (the stuck-isolate / native-deadlock shape).
            exec._watchdogMs = 300;
            exec._child.kill('SIGSTOP');

            const r = await exec.execute({ ...BASE, code: `module.exports = function(){ return 'never'; };` });
            assert.strictEqual(r.success, false, 'hung dispatch must be watchdog-terminated');
            assert.ok(/watchdog timeout/.test(r.error), 'error should cite the watchdog: ' + r.error);
            assert.strictEqual(r.gasUsed, GAS_CEILING, 'fabricated result clamps gasUsed to the ceiling');

            // And the executor respawns and keeps serving.
            const r2 = await exec.execute({ ...BASE, code: `module.exports = function(){ return 'after'; };` });
            assert.strictEqual(r2.returnValue, '"after"');
        } finally {
            await exec.shutdown();
        }
    });

    // The deterministic case is UNCHANGED: a single worker death during an
    // in-flight execution still RESOLVES a fabricated host-termination (every
    // validator sees the same poisoned-contract outcome); it must NOT reject.
    it('a single in-flight worker death still FABRICATES (resolves), not rejects', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            await exec.execute({ ...BASE, code: `module.exports = function(){ return 1; };` }); // ensure ready
            const inFlight = exec.execute({ ...BASE, code: `module.exports = function(){ return 2; };` });
            if (exec._child) exec._child.kill('SIGKILL'); // crash mid-flight (not _broken)
            const r = await inFlight;
            assert.strictEqual(r.success, false, 'in-flight crash should resolve a host-termination');
            assert.strictEqual(r.gasUsed, GAS_CEILING, 'fabricated result clamps gasUsed to the ceiling');
        } finally {
            await exec.shutdown();
        }
    });
});

// ===========================================================================
// Single-in-flight dispatch invariant. The per-entry watchdog starts at
// DISPATCH and must bound exactly ONE contract's execution; the worker runs
// strictly sequentially, so if the executor dispatched the whole queue at
// once, a 2nd+ entry's watchdog would tick during the 1st entry's runtime
// and a slow validator would fabricate 'watchdog timeout' for a contract a
// fast validator ran normally (a fork). The production embedder awaits every
// execute(), but the executor itself now ENFORCES at-most-one in flight so a
// future non-awaiting caller cannot silently re-open the divergence.
// ===========================================================================
(HAVE_IVM ? describe : describe.skip)('process-executor: single-in-flight dispatch invariant', function () {
    this.timeout(60000);

    it('concurrent execute() calls are dispatched one at a time and all complete', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            // Fire several executions back-to-back WITHOUT awaiting between
            // them (the non-serialized caller the invariant defends against).
            const mk = (i) => exec.execute({ ...BASE,
                code: `module.exports = function(){ var s=''; for(var i=0;i<2000;i++){ s+='x'; } return ${i}; };` });
            const jobs = [mk(0), mk(1), mk(2), mk(3)];

            // The executor must never have more than one entry in flight.
            let maxPending = 0;
            const probe = setInterval(() => { maxPending = Math.max(maxPending, exec._pending.size); }, 1);

            const results = await Promise.all(jobs);
            clearInterval(probe);

            assert.ok(maxPending <= 1, 'at most one entry may be in flight, saw ' + maxPending);
            results.forEach((r, i) => {
                assert.strictEqual(r.success, true, 'job ' + i + ' must complete: ' + r.error);
                assert.strictEqual(r.returnValue, String(i));
                assert.ok(r.error === null, 'no job may be watchdog-terminated');
            });
        } finally {
            await exec.shutdown();
        }
    });

    it('a queued entry has no watchdog timer until it dispatches (queue wait never counts)', async function () {
        const ProcessExecutor = require('../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            // Warm the worker so dispatch is immediate for the first job.
            await exec.execute({ ...BASE, code: 'module.exports = function(){ return 0; };' });

            const slow = exec.execute({ ...BASE,
                code: `module.exports = function(){ var s=''; for(var i=0;i<50000;i++){ s+='x'; } return 'slow'; };` });
            const queued = exec.execute({ ...BASE, code: 'module.exports = function(){ return "q"; };' });

            // While the first job runs, the second must sit in _queue with NO
            // timer armed (its watchdog may only start at its own dispatch).
            assert.strictEqual(exec._pending.size, 1, 'exactly one entry in flight');
            assert.strictEqual(exec._queue.length, 1, 'second entry must be queued');
            assert.strictEqual(exec._queue[0].timer, null, 'queued entry must have no watchdog timer');

            const r1 = await slow;
            const r2 = await queued;
            assert.strictEqual(r2.success, true, 'queued entry must run after the first settles: ' + r2.error);
            assert.strictEqual(r2.returnValue, '"q"');
            assert.strictEqual(r1.returnValue, '"slow"');
        } finally {
            await exec.shutdown();
        }
    });
});
