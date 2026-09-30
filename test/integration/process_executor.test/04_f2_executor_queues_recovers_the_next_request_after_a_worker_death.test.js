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


const { assert, hashResult, GAS_SCHEDULE, LIMITS, GAS_CEILING, makeVM, BASE, HAVE_IVM } = require('./support/executor_setup.js');

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
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('F2: executor queues+recovers the next request after a worker death', async function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
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
});
