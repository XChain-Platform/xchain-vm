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
 * fork() throws synchronously for errnos outside the five Node reports
 * asynchronously (ENOMEM and kin). Unwrapped, that throw escaped execute()
 * during a recovery probe (leaving the executor un-latched with no worker,
 * so later work queued forever), escaped the constructor, and escaped the
 * respawn inside a worker's exit handling as an uncaught exception. Every
 * spawn site now treats the throw as a failed spawn.
 ********************************************************************/
// @ts-nocheck

const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./support/liveness_setup.js');
const { assert } = H;

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: a throwing fork', function () {
    this.timeout(30000);

    afterEach(function () { H.forkHook.throwErr = null; });

    it('a recovery probe whose fork throws rejects instead of throwing, and nothing wedges', async function () {
        const PE = H.loadHookedExecutor();
        const exec = H.newExec(PE);
        try {
            await H.killPreReady(exec, 3);
            assert.strictEqual(exec._broken, true);
            await H.sleep(2100); // past the backoff, so execute() probes a spawn
            H.forkHook.throwErr = H.enomem();
            let syncThrow = null, probe = null;
            try { probe = H.track(exec.execute(H.quick(1))); } catch (e) { syncThrow = e; }
            assert.strictEqual(syncThrow, null, 'execute() must return a rejected promise, not throw');
            const later = H.track(exec.execute(H.quick(2)));
            await H.waitFor(() => probe.state !== 'pending' && later.state !== 'pending', 3000);
            assert.strictEqual(probe.state, 'rejected');
            assert.ok(H.isHostFault(probe.value), 'got ' + probe.value);
            assert.match(probe.value.message, /ENOMEM/);
            assert.strictEqual(later.state, 'rejected', 'later work must not wedge');
            assert.strictEqual(exec._broken, true);
            H.forkHook.throwErr = null;
            await H.sleep(2100);
            const r = await exec.execute(H.quick(3));
            assert.strictEqual(r.returnValue, '"r3"', 'the executor self-heals once fork works again');
        } finally { await exec.shutdown(); }
    });

    it('a constructor whose fork throws returns a latched executor instead of throwing', async function () {
        const PE = H.loadHookedExecutor();
        H.forkHook.throwErr = H.enomem();
        let exec = null, ctorThrow = null;
        try { exec = H.newExec(PE); } catch (e) { ctorThrow = e; }
        assert.strictEqual(ctorThrow, null, 'the constructor must not throw on a fork failure');
        try {
            assert.strictEqual(exec._broken, true);
            await assert.rejects(exec.execute(H.quick(4)), H.isHostFault);
        } finally { H.forkHook.throwErr = null; await exec.shutdown(); }
    });

    it('a throwing fork in the respawn after a contract crash is no uncaught exception', function () {
        const script = path.join(__dirname, 'support', 'respawn_throw_child.js');
        let out, status = 0;
        try { out = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 }); }
        catch (e) { out = e.stdout || ''; status = e.status; }
        const line = String(out).trim().split('\n').pop();
        const res = JSON.parse(line);
        assert.strictEqual(status, 0, 'the host saw an uncaught exception: ' + line);
        assert.strictEqual(res.uncaught, null);
        assert.strictEqual(res.victim, 'resolved', 'the crashing contract still resolves its clamp: ' + line);
        assert.match(String(res.victimError), /^out_of_resource: execution host terminated/);
        assert.strictEqual(res.queued, 'rejected', 'queued work settles as a host fault: ' + line);
        assert.strictEqual(res.queuedHostFault, true);
        assert.strictEqual(res.broken, true);
    });
});
