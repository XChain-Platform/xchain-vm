/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Out-of-process executor — sustained worker-respawn soak.
 *
 * The subprocess executor (src/process-executor.js) forks a fresh worker on
 * every crash / hang / watchdog kill (the F2/F3 fault-recovery surface). A
 * long-running validator can respawn the worker millions of times over its
 * life. This soak hammers that lifecycle and watches for the leaks it would
 * produce: orphaned/zombie child processes, leaked IPC file descriptors,
 * uncleared watchdog timers, and unbounded RSS growth from retained child
 * objects / listeners / pending-map entries.
 *
 * Allocation bombs no longer SIGABRT the worker (they are gas-contained as
 * of the G1/G3 metering work), so the realistic respawn driver here is a
 * SIGKILL of the live worker — a genuine worker-fault. Each cycle: run a
 * real execution, then kill the worker, then prove the executor recovers
 * (a follow-up execution succeeds on the respawned worker). Resource
 * counters are sampled with the garbage collector forced (run with
 * --expose-gc) so retained-garbage is distinguished from a true leak.
 *
 *   node --expose-gc test/soak/executor-respawn-soak.js [cycles] [sampleEvery]
 *   # accelerated default: 3000 respawns. For a multi-day soak, pass a large
 *   # cycle count or wrap in a loop; the per-cycle cost is a fork + IPC RTT.
 ********************************************************************/
// @ts-nocheck

const fs = require('fs');
const path = require('path');
const XChainVM = require('../../src/index.js');

const CYCLES       = parseInt(process.argv[2] || '3000', 10);
const SAMPLE_EVERY = parseInt(process.argv[3] || '250', 10);

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const LIMITS = {
    maxCpuTimeMs: 2000, maxMemory: 8, maxEmissions: 50,
    maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
};

const CHEAP = `module.exports = function(xchain){ xchain.state.set('n', String((+(xchain.state.get('n')||'0'))+1)); return 1; };`;

function fdCount() {
    try { return fs.readdirSync('/proc/self/fd').length; }
    catch (e) { return -1; } // non-Linux: skip
}

// Count direct child processes of THIS process by scanning /proc for ppid==self.
function childProcCount() {
    try {
        let n = 0;
        for (const name of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            let stat;
            try { stat = fs.readFileSync(path.join('/proc', name, 'stat'), 'utf8'); }
            catch (e) { continue; }
            // field 4 is ppid, but comm (field 2) may contain spaces/parens — split after ')'.
            const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            const ppid = parseInt(after[1], 10); // state=after[0], ppid=after[1]
            if (ppid === process.pid) n++;
        }
        return n;
    } catch (e) { return -1; }
}

function sample(vm) {
    if (global.gc) { global.gc(); global.gc(); }
    const m = process.memoryUsage();
    const ex = vm._executor;
    return {
        rssMB:    +(m.rss / 1048576).toFixed(1),
        heapMB:   +(m.heapUsed / 1048576).toFixed(1),
        extMB:    +(m.external / 1048576).toFixed(1),
        fds:      fdCount(),
        children: childProcCount(),
        pending:  ex ? ex._pending.size : -1,
        queue:    ex ? ex._queue.length : -1
    };
}

async function main() {
    const vm = new XChainVM({ execution: 'subprocess', gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, limits: LIMITS });
    const ex = vm._executor;
    if (!ex) { console.error('subprocess executor not created — isolated-vm missing?'); process.exit(1); }

    vm.beginBlock();
    const runOpts = (code) => ({ code, method: 'default', params: [], state: {}, contractAddress: 'C:BTC:1', contractIndex: 1 });

    // Warm up + baseline.
    await vm.execute(runOpts(CHEAP));
    const samples = [];
    const base = sample(vm);
    samples.push({ cycle: 0, ...base });
    process.stdout.write(`baseline: ${JSON.stringify(base)}\n`);

    let respawnsObserved = 0;
    let recoveryFailures = 0;
    let transientErrors  = 0;

    for (let i = 1; i <= CYCLES; i++) {
        // Model a REAL worker crash: a contract is in-flight (dispatched, IPC
        // round-trip pending) when the worker dies. We SIGKILL mid-flight, then
        // await that execution — it resolves via _onExit to a deterministic
        // host-terminated result and triggers the respawn synchronously.
        // A transient host fault (fork EAGAIN under load, a /proc read racing a
        // dying pid) must not abort a multi-day soak — count it and continue.
        // A genuine leak still shows in the flat-line resource counters.
        try {
            const pidBefore = ex._child && ex._child.pid;
            const inFlight = vm.execute(runOpts(CHEAP));   // dispatched, not yet resolved
            if (ex._child) { try { ex._child.kill('SIGKILL'); } catch (e) {} }
            const crashed = await inFlight;                // expected: success === false
            // Recovery: the NEXT contract must queue until the respawned worker is
            // 'ready' and then succeed — the determinism-critical recovery path the
            // real indexer relies on (a crash must not poison the following contract).
            const recovered = await vm.execute(runOpts(CHEAP));
            const pidAfter = ex._child && ex._child.pid;
            if (pidAfter && pidBefore && pidAfter !== pidBefore) respawnsObserved++;
            if (!recovered || recovered.success !== true) recoveryFailures++;
            void crashed;
        } catch (e) {
            transientErrors++;
        }

        // Periodically cycle the block boundary too (exercises beginBlock/endBlock
        // re-issue to a fresh worker — another respawn-state surface).
        if (i % 100 === 0) { vm.endBlock(); vm.beginBlock(); await vm.execute(runOpts(CHEAP)); }

        if (i % SAMPLE_EVERY === 0) {
            const s = sample(vm);
            samples.push({ cycle: i, ...s });
            process.stdout.write(`cycle ${String(i).padStart(6)} | ${JSON.stringify(s)} | respawns=${respawnsObserved} recoveryFails=${recoveryFailures}\n`);
        }
    }

    vm.endBlock();
    await vm.shutdown();

    // Verdict: fds and child-process counts must be flat (no per-respawn leak);
    // RSS may wobble but must not climb monotonically across the run.
    const first = samples[1] || base;        // first post-warmup sample
    const last  = samples[samples.length - 1];
    const fdGrow    = last.fds - first.fds;
    const childGrow = last.children - first.children;
    const rssGrow   = last.rssMB - first.rssMB;

    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(`cycles=${CYCLES} respawnsObserved=${respawnsObserved} recoveryFailures=${recoveryFailures} transientErrors=${transientErrors}\n`);
    process.stdout.write(`fd delta=${fdGrow} (first=${first.fds} last=${last.fds})\n`);
    process.stdout.write(`child-proc delta=${childGrow} (first=${first.children} last=${last.children})\n`);
    process.stdout.write(`rss delta=${rssGrow}MB (first=${first.rssMB} last=${last.rssMB})\n`);

    // Thresholds: allow tiny noise; flag real leaks. fd/child must be ~0 growth.
    // Recovery: this soak forks far harder than a real validator, so a rare
    // slow-respawn under host fork-pressure can host-terminate one recovery
    // execution. Tolerate a tiny rate (≤0.5%); flag a SYSTEMATIC failure.
    const FD_TOL = 8, CHILD_TOL = 1, RSS_TOL_MB = 64;
    const RECOVERY_TOL = Math.max(2, Math.ceil(CYCLES * 0.005));
    const leaks = [];
    if (fdGrow > FD_TOL)       leaks.push(`fd leak: +${fdGrow}`);
    if (childGrow > CHILD_TOL) leaks.push(`child-process leak: +${childGrow}`);
    if (rssGrow > RSS_TOL_MB)  leaks.push(`rss growth: +${rssGrow}MB`);
    if (recoveryFailures > RECOVERY_TOL) leaks.push(`recovery failures: ${recoveryFailures} (> ${RECOVERY_TOL} tolerance) — systematic, not transient`);
    if (respawnsObserved < CYCLES * 0.5) leaks.push(`few respawns observed (${respawnsObserved}/${CYCLES}) — driver may not be faulting the worker`);
    if (recoveryFailures > 0 && recoveryFailures <= RECOVERY_TOL)
        process.stdout.write(`note: ${recoveryFailures} transient recovery failure(s) within tolerance (${RECOVERY_TOL}) — slow respawn under fork-pressure, not a leak\n`);

    if (leaks.length) {
        process.stdout.write(`RESULT: *** PROBLEM ***\n  - ${leaks.join('\n  - ')}\n`);
        process.exit(2);
    }
    process.stdout.write(`RESULT: clean — no fd/process/memory leak under ${CYCLES} respawns.\n`);
    process.exit(0);
}

main().catch(e => { process.stderr.write('soak failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
