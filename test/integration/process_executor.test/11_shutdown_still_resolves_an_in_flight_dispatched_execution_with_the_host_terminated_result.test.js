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

    // The in-flight half of the same fix must be unchanged: an execution
    // already DISPATCHED to the worker when shutdown() runs still RESOLVES
    // with the deterministic host-terminated result (every validator sees
    // the same poisoned-contract outcome for work that actually started).
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('shutdown() still RESOLVES an in-flight (dispatched) execution with the host-terminated result', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            await exec.execute({ ...BASE, code: `module.exports = function(){ return 'warm'; };` }); // ensure ready

            const inFlight = exec.execute({ ...BASE, code: `module.exports = function(){ return 'mid'; };` });
            assert.strictEqual(exec._pending.size, 1, 'request must be dispatched (in-flight)');

            await exec.shutdown();

            const r = await inFlight;
            assert.strictEqual(r.success, false, 'in-flight execution interrupted by shutdown resolves a failure');
            assert.match(r.error, /out_of_resource/, 'must be the deterministic host-terminated result');
            assert.strictEqual(r.gasUsed, GAS_CEILING, 'fabricated result clamps gasUsed to the ceiling');
        } finally {
            // shutdown() already ran above; calling again is a harmless no-op.
        }
    });
});
