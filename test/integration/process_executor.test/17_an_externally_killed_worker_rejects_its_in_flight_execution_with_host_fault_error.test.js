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
 * Out-of-process executor: a worker killed from OUTSIDE (the kernel OOM
 * killer, a process-group signal) is a local host fault, not a contract
 * outcome. Its in-flight execution rejects so the caller halts and retries;
 * resolving out_of_resource here would commit a result no peer commits.
 ********************************************************************/
// @ts-nocheck

const { assert, GAS_SCHEDULE, LIMITS, GAS_CEILING, BASE, HAVE_IVM } = require('./support/executor_setup.js');

const job = (ret) => ({ ...BASE, code: `module.exports = function(){ return '${ret}'; };` });

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('an external SIGKILL rejects the in-flight execution with EXECUTOR_UNAVAILABLE', async function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        try {
            await exec.execute(job('warm')); // ensure ready
            const inFlight = exec.execute(job('mid'));
            assert.strictEqual(exec._pending.size, 1, 'request must be dispatched (in-flight)');
            exec._child.kill('SIGKILL');
            await assert.rejects(inFlight, (e) => e.name === 'HostFaultError' && e.code === 'EXECUTOR_UNAVAILABLE',
                'an outside kill must reject, never resolve a fabricated out_of_resource');
            // The respawned worker serves the retry with the contract's real result.
            const retry = await exec.execute(job('mid'));
            assert.strictEqual(retry.success, true, retry.error);
            assert.strictEqual(retry.returnValue, '"mid"');
        } finally {
            await exec.shutdown();
        }
    });
});
