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

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('host fault: a broken executor SELF-HEALS once the host recovers', async function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        exec.beginBlock();
        const pidA = exec._child.pid;
        let shutDown = false;
        try {
            // Broken, but the backoff has elapsed → execute() probes a fresh spawn,
            // which succeeds (the host is actually fine here) → the request runs.
            exec._broken = true;
            exec._lastBrokenRetryAt = 0;
            const r = await exec.execute({ ...BASE, code: `module.exports = function(){ return 'healed'; };` });
            assert.strictEqual(r.success, true, 'recovery probe should run the contract: ' + r.error);
            assert.strictEqual(r.returnValue, '"healed"');
            assert.strictEqual(exec._broken, false, '_broken must clear after a successful recovery');
            assert.notStrictEqual(exec._child.pid, pidA, 'the probe forks a fresh worker');
            await exec.shutdown();
            shutDown = true;
            // The probe must retire the worker it replaced: no process left behind.
            let alive = true;
            for (let i = 0; i < 50 && alive; i++) {
                try { process.kill(pidA, 0); await new Promise((res) => setTimeout(res, 100)); }
                catch (e) { alive = e.code !== 'ESRCH'; if (alive) throw e; }
            }
            assert.strictEqual(alive, false, 'replaced worker ' + pidA + ' must not survive shutdown()');
        } finally {
            if (!shutDown) await exec.shutdown();
            try { process.kill(pidA, 'SIGKILL'); } catch (e) {}
        }
    });
});
