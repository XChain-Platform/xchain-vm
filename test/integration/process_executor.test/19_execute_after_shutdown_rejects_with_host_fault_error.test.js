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
 * Use after shutdown: once shutdown() has run, no worker is ever spawned or
 * dispatched to again, so an execute() that queued would never settle. It must
 * reject at once with the same local host fault shutdown() gives queued work.
 ********************************************************************/
// @ts-nocheck


const { assert, GAS_SCHEDULE, LIMITS, GAS_CEILING, BASE, HAVE_IVM } = require('./support/executor_setup.js');

// Race a promise against a short timer so a hang fails by name, not by mocha timeout.
function settleOrHang(promise, ms) {
    let timer;
    const hang = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('execute() after shutdown() hung')), ms);
    });
    return Promise.race([promise, hang]).finally(() => clearTimeout(timer));
}

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    const ProcessExecutor = require('../../../src/process-executor.js');
    const { HostFaultError } = require('../../../src/errors.js');
    const CODE = `module.exports = function(){ return 'never'; };`;

    it('execute() after shutdown() rejects with HostFaultError instead of hanging', async function () {
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        await exec.shutdown();
        await assert.rejects(
            settleOrHang(exec.execute({ ...BASE, code: CODE }), 2000),
            (e) => e instanceof HostFaultError,
            'a post-shutdown execute() must reject with HostFaultError');
        assert.strictEqual(exec._queue.length, 0, 'a post-shutdown request must not be queued');
    });

    it('execute() after shutdown() rejects before the broken-latch recovery probe', async function () {
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        await exec.shutdown();
        exec._broken = true;
        exec._lastBrokenRetryAt = 0;
        await assert.rejects(
            settleOrHang(exec.execute({ ...BASE, code: CODE }), 2000),
            (e) => e instanceof HostFaultError,
            'a post-shutdown execute() on a broken executor must reject with HostFaultError');
        assert.strictEqual(exec._broken, true, 'the guard must run before the broken latch is cleared');
        assert.strictEqual(exec._queue.length, 0, 'a post-shutdown request must not be queued');
    });
});
