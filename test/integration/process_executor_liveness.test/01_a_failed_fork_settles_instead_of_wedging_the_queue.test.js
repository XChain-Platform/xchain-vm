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
 * A fork() that fails asynchronously (EACCES, EAGAIN, EMFILE, ENFILE,
 * ENOENT) emits 'error' and 'close' but never 'exit'. The executor once
 * listened only for 'exit', so the failed worker was never counted, never
 * replaced, and every execute() queued forever behind it. A failed fork is
 * now a worker lost before ready: it counts toward the broken latch, a
 * transient failure is replaced and the queued work runs, and a persistent
 * one trips the latch and settles queued work as HostFaultError.
 ********************************************************************/
// @ts-nocheck

const H = require('./support/liveness_setup.js');
const { assert } = H;

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: a failed fork', function () {
    this.timeout(30000);

    it('a persistently failing fork rejects queued work with HostFaultError and trips the latch', async function () {
        let exec;
        await H.withExecPath(H.MISSING_NODE, async () => {
            exec = H.newExec();
            exec.beginBlock();
            const t = H.track(exec.execute(H.quick(1)));
            await H.waitFor(() => t.state !== 'pending', 5000);
            assert.strictEqual(t.state, 'rejected', 'a failed fork must settle the queued run, not wedge it');
            assert.ok(H.isHostFault(t.value), 'must be a host fault (halt and retry), got ' + t.value);
            assert.match(t.value.message, /ENOENT/, 'the spawn errno should reach the reason: ' + t.value.message);
            assert.strictEqual(exec._broken, true, 'repeated fork failures trip the broken latch');
            assert.strictEqual(exec._queue.length, 0);
        });
        try {
            // The host recovers: after the backoff a probe spawns a real worker.
            await H.sleep(2100);
            const r = await exec.execute(H.quick(2));
            assert.strictEqual(r.returnValue, '"r2"');
            assert.strictEqual(exec._broken, false);
        } finally { await exec.shutdown(); }
    });

    it('a single failed fork is replaced and the queued work runs on the replacement', async function () {
        let exec;
        // Only the constructor's fork sees the bad path; the replacement forks normally.
        await H.withExecPath(H.MISSING_NODE, async () => { exec = H.newExec(); });
        try {
            exec.beginBlock();
            const t = H.track(exec.execute(H.quick(3)));
            await H.waitFor(() => t.state !== 'pending', 5000);
            assert.strictEqual(t.state, 'resolved', 'the queued run must not stay wedged behind the failed fork');
            assert.strictEqual(t.value.returnValue, '"r3"');
            assert.strictEqual(exec._consecutiveSpawnFailures, 0, 'a ready worker resets the counter');
            assert.strictEqual(exec._broken, false);
        } finally { await exec.shutdown(); }
    });

    it('a recovery probe whose fork fails rejects the probe and later work instead of wedging', async function () {
        const exec = H.newExec();
        try {
            await H.killPreReady(exec, 3);
            assert.strictEqual(exec._broken, true);
            await H.sleep(2100); // past the backoff, so execute() probes a spawn
            await H.withExecPath(H.MISSING_NODE, async () => {
                const probe = H.track(exec.execute(H.quick(4)));
                await H.waitFor(() => probe.state !== 'pending', 5000);
                assert.strictEqual(probe.state, 'rejected', 'the probe run must settle');
                assert.ok(H.isHostFault(probe.value), 'got ' + probe.value);
                const later = H.track(exec.execute(H.quick(5)));
                await H.waitFor(() => later.state !== 'pending', 1000);
                assert.strictEqual(later.state, 'rejected', 'later work must not queue behind a dead probe');
                assert.ok(H.isHostFault(later.value), 'got ' + later.value);
            });
        } finally { await exec.shutdown(); }
    });
});
