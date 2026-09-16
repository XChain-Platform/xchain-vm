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

    // Watchdog must bound EXECUTION, not queue-wait + execution. Started at
    // acceptance it also counted time spent queued, so a validator whose queue
    // was backed up (many contracts in a block, slow disk, a respawn in
    // progress) fabricated out_of_resource for a contract every other
    // validator executed normally → divergent contract status → fork. A
    // request that waits in the queue for many watchdog windows must still
    // run and succeed once the worker is dispatchable.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('a queued request never times out on queue wait (watchdog starts at dispatch)', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
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
            exec.flush();
            const r = await queued;
            assert.strictEqual(r.success, true,
                'queue wait must never produce out_of_resource (fork risk): ' + r.error);
            assert.strictEqual(r.returnValue, '"queued"');
        } finally {
            await exec.shutdown();
        }
    });
});
