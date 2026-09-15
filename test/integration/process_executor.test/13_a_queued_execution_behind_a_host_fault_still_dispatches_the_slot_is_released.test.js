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

    // The reject path must also free the dispatch slot. Without the flush() in
    // the hostfault branch the queued entry behind the faulted one would sit in
    // _queue forever (no result, no exit, no watchdog: it was never dispatched),
    // hanging the block instead of halting it.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('a queued execution behind a host fault still dispatches (the slot is released)', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
        const { HostFaultError } = require('../../../src/errors.js');
        const exec = new ProcessExecutor({
            gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING,
            limits: { ...LIMITS, maxMemory: 1 }
        });
        exec.beginBlock();
        try {
            const first  = exec.execute({ ...BASE, code: `module.exports = function(){ return 'a'; };` });
            const second = exec.execute({ ...BASE, code: `module.exports = function(){ return 'b'; };` });
            // Both faults are host-local on this executor, so both must REJECT.
            // The point is that the second one settles at all.
            await assert.rejects(first,  (e) => e instanceof HostFaultError);
            await assert.rejects(second, (e) => e instanceof HostFaultError,
                'the entry queued behind a host fault must dispatch, not stall');
            assert.strictEqual(exec._queue.length, 0, 'the queue must have drained');
        } finally {
            await exec.shutdown();
        }
    });
});
