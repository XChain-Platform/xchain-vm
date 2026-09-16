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

// Single-in-flight dispatch invariant. The per-entry watchdog starts at
// DISPATCH and must bound exactly ONE contract's execution; the worker runs
// strictly sequentially, so if the executor dispatched the whole queue at
// once, a 2nd+ entry's watchdog would tick during the 1st entry's runtime
// and a slow validator would fabricate 'watchdog timeout' for a contract a
// fast validator ran normally (a fork). The production embedder awaits every
// execute(), but the executor itself now ENFORCES at-most-one in flight so a
// future non-awaiting caller cannot silently re-open the divergence.
(HAVE_IVM ? describe : describe.skip)('process_executor: single-in-flight dispatch invariant', function () {
    this.timeout(60000);

    it('concurrent execute() calls are dispatched one at a time and all complete', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
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
        const ProcessExecutor = require('../../../src/process_executor.js');
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
