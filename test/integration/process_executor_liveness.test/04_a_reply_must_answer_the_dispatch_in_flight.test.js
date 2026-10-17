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
 * The executor accepted any result reply whose id was in flight, with no
 * check on its shape and nothing tying it to the dispatch. A reply queued
 * by the worker ahead of a dispatch could name the next id and be taken as
 * that run's result, and a reply with no result resolved `undefined`. A
 * reply now has to echo the dispatch's token and carry a well-formed
 * result; one that names the in-flight id and fails either check is a
 * worker fault (the worker is killed and replaced, the run rejects as a
 * host fault), never a result. Replies for ids not in flight stay ignored.
 ********************************************************************/
// @ts-nocheck

const H = require('./support/liveness_setup.js');
const { assert } = H;

const fake = (mode, fn) => H.withPreload('fake_reply_preload.js', { XVM_TEST_FAKE_REPLY: mode }, fn);

async function runQuick(exec, n) {
    const ts = [];
    for (let i = 0; i < n; i++) ts.push(H.track(exec.execute(H.quick(i))));
    await H.waitFor(() => ts.every((t) => t.state !== 'pending'), 20000, 20);
    return ts;
}

async function futureReplyIsAWorkerFault() {
    await fake('future', async () => {
        const exec = H.newExec();
        exec.beginBlock();
        try {
            const ts = await runQuick(exec, 6);
            const forged = ts.filter((t) => t.state === 'resolved' && /FORGED/.test(t.value.returnValue));
            assert.strictEqual(forged.length, 0, 'forged replies accepted: ' + JSON.stringify(ts.map((t) => t.value && t.value.returnValue)));
            ts.forEach((t, i) => {
                assert.notStrictEqual(t.state, 'pending', 'run ' + i + ' must settle');
                if (t.state === 'resolved') assert.strictEqual(t.value.returnValue, JSON.stringify('r' + i));
                else assert.ok(H.isHostFault(t.value), 'run ' + i + ' must reject as a host fault, got ' + t.value);
            });
            assert.ok(ts.some((t) => t.state === 'rejected'), 'the forged reply must be treated as a worker fault');
        } finally { await exec.shutdown(); }
    });
}

async function duplicateReplyIsIgnored() {
    await fake('dup', async () => {
        const exec = H.newExec();
        exec.beginBlock();
        try {
            const ts = await runQuick(exec, 8);
            ts.forEach((t, i) => {
                assert.strictEqual(t.state, 'resolved', 'run ' + i);
                assert.strictEqual(t.value.returnValue, JSON.stringify('r' + i));
            });
        } finally { await exec.shutdown(); }
    });
}

async function staleReplyIsIgnored() {
    await fake('stale', async () => {
        const exec = H.newExec();
        exec.beginBlock();
        try {
            const ts = await runQuick(exec, 8);
            ts.forEach((t, i) => {
                assert.strictEqual(t.state, 'resolved', 'run ' + i);
                assert.strictEqual(t.value.returnValue, JSON.stringify('r' + i));
            });
        } finally { await exec.shutdown(); }
    });
}

async function replacedWorkerAndRepeatReadyAreIgnored() {
    const exec = H.newExec();
    exec.beginBlock();
    try {
        await exec.execute(H.quick(1));
        exec._sawReady = false;
        exec.onMessage({ type: 'ready' }, {});              // not the current worker
        assert.strictEqual(exec._sawReady, false);
        exec.onMessage({ type: 'ready' }, exec._child);     // a second ready from the current one
        assert.strictEqual(exec._sawReady, false, 'a repeat ready must not reopen dispatch');
        exec._sawReady = true;
    } finally { await exec.shutdown(); }
}

(H.HAVE_IVM ? describe : describe.skip)('process_executor liveness: reply checks', function () {
    this.timeout(60000);
    it('a reply naming the next (not yet dispatched) id is never accepted as its result', futureReplyIsAWorkerFault);
    it('a duplicate reply for a settled id never displaces the real result', duplicateReplyIsIgnored);
    it('a late reply for an already-settled id is ignored', staleReplyIsIgnored);
    it('frames from a replaced worker and repeated ready frames are ignored', replacedWorkerAndRepeatReadyAreIgnored);
});
