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

    // A shutdown is local to this node, so an execution already DISPATCHED when
    // shutdown() runs REJECTS with HostFaultError like the queued ones: every
    // other validator finishes that contract normally, so a fabricated
    // out_of_resource here would be a result no peer commits.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('shutdown() REJECTS an in-flight (dispatched) execution with HostFaultError', async function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            await exec.execute({ ...BASE, code: `module.exports = function(){ return 'warm'; };` }); // ensure ready

            const inFlight = exec.execute({ ...BASE, code: `module.exports = function(){ return 'mid'; };` });
            assert.strictEqual(exec._pending.size, 1, 'request must be dispatched (in-flight)');

            await exec.shutdown();

            await assert.rejects(inFlight, (e) => e.name === 'HostFaultError' && e.code === 'EXECUTOR_UNAVAILABLE',
                'an in-flight execution interrupted by shutdown must reject as a host fault, never resolve');
        } finally {
            // shutdown() already ran above; calling again is a harmless no-op.
        }
    });
});
