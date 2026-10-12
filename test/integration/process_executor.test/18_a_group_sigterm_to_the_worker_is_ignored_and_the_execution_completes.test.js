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
 * Out-of-process executor: the worker ignores group signals (Ctrl-C, a
 * systemd control-group stop), because the parent owns its lifecycle. A
 * graceful drain then finishes the in-flight block on real results.
 ********************************************************************/
// @ts-nocheck

const { assert, GAS_SCHEDULE, LIMITS, GAS_CEILING, BASE, HAVE_IVM } = require('./support/executor_setup.js');

const job = (ret) => ({ ...BASE, code: `module.exports = function(){ return '${ret}'; };` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        it(sig + ' sent to the worker mid-execution is ignored and the execution resolves normally', async function () {
            const ProcessExecutor = require('../../../src/process-executor.js');
            const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
            exec.beginBlock();
            try {
                await exec.execute(job('warm')); // ensure ready
                const pid = exec._child.pid;
                const inFlight = exec.execute(job('mid'));
                process.kill(pid, sig);
                const r = await inFlight;
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, '"mid"');
                // The worker must survive the signal, not merely outrun it.
                await sleep(300);
                assert.ok(exec._child && exec._child.pid === pid, 'the worker died on ' + sig + ' and was respawned');
                const after = await exec.execute(job('after'));
                assert.strictEqual(after.returnValue, '"after"');
            } finally {
                await exec.shutdown();
            }
        });
    }
});
