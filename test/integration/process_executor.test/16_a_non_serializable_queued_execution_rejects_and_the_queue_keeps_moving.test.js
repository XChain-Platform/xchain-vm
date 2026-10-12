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
 * Out-of-process executor: an execution whose opts cannot cross the JSON IPC
 * channel (a BigInt, a circular object) rejects as a host fault, and the
 * queue behind it keeps moving instead of stalling on it forever.
 ********************************************************************/
// @ts-nocheck

const { assert, GAS_SCHEDULE, LIMITS, GAS_CEILING, BASE, HAVE_IVM } = require('./support/executor_setup.js');

// Fail fast instead of at the mocha timeout when a promise never settles.
function within(promise, ms, what) {
    let timer;
    const stall = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' never settled')), ms); });
    return Promise.race([promise, stall]).finally(() => clearTimeout(timer));
}

const job = (ret, extra) => ({ ...BASE, extra, code: `module.exports = function(){ return '${ret}'; };` });

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    for (const [label, makeBad] of [['a BigInt', () => 1n], ['a circular object', () => { const c = {}; c.self = c; return c; }]]) {
        it('opts holding ' + label + ' reject with HostFaultError and the next execution still runs', async function () {
            const ProcessExecutor = require('../../../src/process-executor.js');
            const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
            exec.beginBlock();
            try {
                await exec.execute(job('warm')); // ensure ready, so the bad entry dispatches from flush()
                const bad = exec.execute(job('a', makeBad()));
                const good = exec.execute(job('b'));
                await assert.rejects(within(bad, 10000, 'the unserializable execution'),
                    (e) => e.name === 'HostFaultError' && e.code === 'EXECUTOR_UNAVAILABLE' && /not serializable/.test(e.message));
                const r = await within(good, 10000, 'the execution queued behind it');
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, '"b"');
                assert.strictEqual(exec._queue.length, 0, 'the queue must have drained');
                assert.strictEqual(exec._pending.size, 0, 'nothing may stay in flight');
            } finally {
                await exec.shutdown();
            }
        });
    }
});
