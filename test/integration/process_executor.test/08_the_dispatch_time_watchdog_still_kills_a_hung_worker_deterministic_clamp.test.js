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

    // The dispatch-time watchdog still catches a genuinely stuck worker: a
    // dispatched request on a frozen child resolves the deterministic
    // resource-failure clamp and the executor recovers for subsequent work.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('the dispatch-time watchdog still kills a hung worker (deterministic clamp)', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
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
});
