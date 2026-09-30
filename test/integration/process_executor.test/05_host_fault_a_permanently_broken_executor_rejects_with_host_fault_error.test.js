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

    // Halt-vs-fabricate: a PERMANENTLY broken executor (worker can never start)
    // must REJECT, not fabricate. Fabricating out_of_resource for work the fleet
    // runs would fork this node off the chain (a host fault is not a contract
    // property). The indexer turns the rejection into a halt-and-retry.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('host fault: a permanently-broken executor REJECTS with HostFaultError', async function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
        const { HostFaultError } = require('../../../src/errors.js');
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
});
