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
 * The broken latch counts workers lost before they signal ready. It once
 * counted only deaths within two seconds of the spawn, so a worker that
 * always died during init just past that age respawned forever and its
 * queued work never settled. Every pre-ready death now counts, whatever
 * its age; a worker that reached ready (a contract crash, an outside kill,
 * a watchdog kill) still never counts.
 ********************************************************************/
// @ts-nocheck

const H = require('./support/liveness_setup.js');
const { assert } = H;

async function slowPreReadyDeathsTripTheLatch() {
    let exec;
    try {
        await H.withPreload('slow_crash_preload.js', { XVM_TEST_CRASH_MS: '2100' }, async () => {
            exec = H.newExec();
            exec.beginBlock();
            const t = H.track(exec.execute(H.quick(1)));
            await H.waitFor(() => t.state !== 'pending', 12000, 50);
            assert.strictEqual(exec._broken, true, 'repeated pre-ready deaths must trip the latch');
            assert.strictEqual(t.state, 'rejected');
            assert.ok(H.isHostFault(t.value), 'got ' + t.value);
        });
    } finally { if (exec) await exec.shutdown(); }
}

async function threeDeathsTripBackoffProbeRecovers() {
    const exec = H.newExec();
    exec.beginBlock();
    try {
        await H.killPreReady(exec, 2);
        assert.strictEqual(exec._consecutiveSpawnFailures, 2);
        assert.strictEqual(exec._broken, false, 'two failures must not trip');
        const queued = H.track(exec.execute(H.quick(2)));
        await H.killPreReady(exec, 1);
        await H.waitFor(() => queued.state !== 'pending', 2000);
        assert.strictEqual(exec._broken, true, 'the third failure trips the latch');
        assert.strictEqual(queued.state, 'rejected');
        assert.ok(H.isHostFault(queued.value));
        exec._lastBrokenRetryAt = Date.now();
        await assert.rejects(exec.execute(H.quick(3)), H.isHostFault);
        await H.sleep(2100);
        const r = await exec.execute(H.quick(4));
        assert.strictEqual(r.returnValue, '"r4"');
        assert.strictEqual(exec._broken, false);
        assert.strictEqual(exec._consecutiveSpawnFailures, 0, 'ready resets the counter');
    } finally { await exec.shutdown(); }
}

async function twoDeathsThenReadyResets() {
    const exec = H.newExec();
    exec.beginBlock();
    try {
        await H.killPreReady(exec, 2);
        const r = await exec.execute(H.quick(5));
        assert.strictEqual(r.returnValue, '"r5"');
        assert.strictEqual(exec._consecutiveSpawnFailures, 0);
        assert.strictEqual(exec._broken, false);
    } finally { await exec.shutdown(); }
}

async function readyWorkerDeathsNeverCount() {
    const exec = H.newExec();
    exec.beginBlock();
    try {
        for (let k = 0; k < 4; k++) {
            const r = await exec.execute(H.quick(10 + k));
            assert.strictEqual(r.returnValue, JSON.stringify('r' + (10 + k)));
            const c = exec._child;
            c.kill('SIGKILL');
            await H.waitFor(() => exec._child !== c, 3000, 2);
            assert.strictEqual(exec._consecutiveSpawnFailures, 0, 'a ready worker death is not a spawn failure');
        }
        assert.strictEqual(exec._broken, false);
        const r = await exec.execute(H.quick(20));
        assert.strictEqual(r.returnValue, '"r20"');
    } finally { await exec.shutdown(); }
}

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: the broken latch', function () {
    this.timeout(30000);
    it('workers that die before ready at 2.1 s each still trip the latch', slowPreReadyDeathsTripTheLatch);
    it('3 pre-ready deaths trip the latch, queued work rejects, the backoff holds, a probe recovers', threeDeathsTripBackoffProbeRecovers);
    it('2 pre-ready deaths then a ready worker: no trip, counter reset', twoDeathsThenReadyResets);
    it('a worker killed after it reached ready never counts, however often', readyWorkerDeathsNeverCount);
});
