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

    // Finding #2716: shutdown() must not fabricate a billed result for a
    // queued (never-dispatched) execution. Only DISPATCHED work may resolve
    // into a contract-visible outcome (see onExit and the broken-latch
    // path); a queued entry never ran, so shutdown racing it must REJECT
    // with a local host fault, not resolve out_of_resource + a ceiling fee
    // for a contract the rest of the fleet ran normally.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('shutdown() REJECTS a never-dispatched queued execution with HostFaultError', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
        const { HostFaultError } = require('../../../src/errors.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        // Hold dispatch closed so the request accepts into _queue and never
        // reaches the worker, exactly the "never-dispatched" shape.
        exec._sawReady = false;

        const queued = exec.execute({ ...BASE, code: `module.exports = function(){ return 'never'; };` });
        assert.strictEqual(exec._queue.length, 1, 'request must be queued, not dispatched');

        await exec.shutdown();

        await assert.rejects(
            queued,
            (e) => e instanceof HostFaultError,
            'a never-dispatched queued execution must reject with HostFaultError on shutdown'
        );
        try {
            const r = await queued;
            assert.fail('must not resolve, got: ' + JSON.stringify(r));
        } catch (e) {
            assert.ok(!(e && typeof e === 'object' && /out_of_resource/.test(e.error || '')),
                'must not fabricate an out_of_resource result');
            assert.notStrictEqual(e && e.gasUsed, GAS_CEILING,
                'must not fabricate a ceiling-billed gasUsed');
        }
    });
});
