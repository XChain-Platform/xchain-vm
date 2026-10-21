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
 ********************************************************************/
// @ts-nocheck

const S = require('../integration/process_executor.test/support/executor_setup.js');
const ProcessExecutor = require('../../src/process-executor.js');

const assert = S.assert;
const CODE = "module.exports = function(){ return xchain.crossChain.getAttestation('BTC', 7); };";
const SNAPSHOT = {
    attestations: { 'BTC:7': 'attested-value-7' },
    settled: { 'BTC:7': true },
    calls: { abcd: { status: 'ok', payload: 'p' } }
};

function newExecutor() {
    return new ProcessExecutor({
        gasSchedule: S.GAS_SCHEDULE,
        gasCeiling: S.GAS_CEILING,
        limits: S.LIMITS
    });
}

async function waitReady(exec) {
    const end = Date.now() + 15000;
    while (!exec._sawReady && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(exec._sawReady, 'worker never became ready');
}

function opts() {
    return Object.assign({}, S.BASE, {
        code: CODE,
        crossChainData: JSON.parse(JSON.stringify(SNAPSHOT))
    });
}

let exec;

async function cleanUpExecutor() {
    if (exec) await exec.shutdown();
    exec = null;
}

function captureFrames() {
    const frames = [];
    const child = exec._child;
    const realSend = child.send.bind(child);
    child.send = function (msg, ...rest) {
        frames.push(JSON.parse(JSON.stringify(msg)));
        return realSend(msg, ...rest);
    };
    return { child, frames, realSend };
}

async function sendsOneSnapshotPerBlock() {
    exec = newExecutor();
    await waitReady(exec);
    const { frames } = captureFrames();

    exec.beginBlock();
    const first = await exec.execute(opts());
    const second = await exec.execute(opts());
    exec.endBlock();

    assert.deepStrictEqual(frames.map((frame) => frame.type),
        ['beginBlock', 'snapshot', 'execute', 'execute', 'endBlock']);
    assert.deepStrictEqual(frames[1].crossChainData, SNAPSHOT);
    assert.strictEqual(frames.filter((frame) => frame.type === 'snapshot').length, 1);
    for (const frame of frames.filter((item) => item.type === 'execute')) {
        assert.deepStrictEqual(frame.opts.crossChainData,
            { __xchainWorkerSnapshot: frames[1].token });
        assert.strictEqual(JSON.stringify(frame).includes('attested-value-7'), false);
    }
    for (const result of [first, second]) {
        assert.strictEqual(result.success, true, JSON.stringify(result));
        assert.strictEqual(JSON.parse(result.returnValue), 'attested-value-7');
    }
}

async function sendsFreshSnapshotForNextBlock() {
    exec = newExecutor();
    await waitReady(exec);
    const { frames } = captureFrames();

    for (let block = 0; block < 2; block++) {
        exec.beginBlock();
        const result = await exec.execute(opts());
        assert.strictEqual(result.success, true, JSON.stringify(result));
        exec.endBlock();
    }

    const snapshots = frames.filter((frame) => frame.type === 'snapshot');
    assert.strictEqual(snapshots.length, 2);
    assert.notStrictEqual(snapshots[0].token, snapshots[1].token);
}

function holdSnapshots() {
    const { child, frames, realSend } = captureFrames();
    let heldSnapshot;
    child.send = function (msg, ...rest) {
        frames.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === 'snapshot') {
            heldSnapshot = msg;
            return true;
        }
        return realSend(msg, ...rest);
    };
    return { child, frames, realSend, get heldSnapshot() { return heldSnapshot; } };
}

async function waitsForSnapshotAcknowledgement() {
    exec = newExecutor();
    await waitReady(exec);
    const held = holdSnapshots();

    exec.beginBlock();
    const resultPromise = exec.execute(opts());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(held.frames.map((frame) => frame.type), ['beginBlock', 'snapshot']);

    held.realSend(held.heldSnapshot);
    const result = await resultPromise;
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.deepStrictEqual(held.frames.map((frame) => frame.type),
        ['beginBlock', 'snapshot', 'execute']);
}

async function ignoresStaleSnapshotAcknowledgement() {
    exec = newExecutor();
    await waitReady(exec);
    const held = holdSnapshots();

    exec.beginBlock();
    const resultPromise = exec.execute(opts());
    await new Promise((resolve) => setImmediate(resolve));
    exec.onMessage({ type: 'snapshotAck', token: 'stale-token' }, held.child);
    assert.deepStrictEqual(held.frames.map((frame) => frame.type), ['beginBlock', 'snapshot']);

    held.realSend(held.heldSnapshot);
    const result = await resultPromise;
    assert.strictEqual(result.success, true, JSON.stringify(result));
}

function snapshotAcknowledgementTests() {
    this.timeout(30000);

    afterEach(cleanUpExecutor);
    it('sends one snapshot per block and keeps snapshot bytes out of execute frames',
        sendsOneSnapshotPerBlock);
    it('sends a fresh snapshot after the next block begins', sendsFreshSnapshotForNextBlock);
    it('does not dispatch until the worker acknowledges the snapshot token',
        waitsForSnapshotAcknowledgement);
    it('ignores an acknowledgement carrying a stale token', ignoresStaleSnapshotAcknowledgement);
}

(S.HAVE_IVM ? describe : describe.skip)('process executor snapshot acknowledgement',
    snapshotAcknowledgementTests);
