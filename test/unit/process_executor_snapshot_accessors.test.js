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
/* eslint-disable no-underscore-dangle */

const S = require('../integration/process_executor.test/support/executor_setup.js');
const ProcessExecutor = require('../../src/process-executor.js');

const assert = S.assert;
const CODE = `module.exports = function () {
    return [
        xchain.crossChain.isSettled('BTC', 7),
        xchain.crossChain.isSettled('BTC', 8),
        xchain.crossChain.getCallResult('ABCD'),
        xchain.crossChain.getCallResult('ef01')
    ];
};`;
const SNAPSHOT = {
    attestations: {},
    settled: { 'BTC:7': true },
    calls: { abcd: { status: 'ok', payload: 'p' } }
};
const EXPECTED = [true, false, { status: 'ok', payload: 'p' }, null];

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
    return frames;
}

async function preservesSnapshotBackedAccessorsAcrossWorkerChannel() {
    exec = newExecutor();
    await waitReady(exec);
    const frames = captureFrames();
    const results = [];

    results.push(await exec.execute(opts()));

    exec.beginBlock();
    results.push(await exec.execute(opts()));
    results.push(await exec.execute(opts()));
    exec.endBlock();

    exec.beginBlock();
    results.push(await exec.execute(opts()));
    exec.endBlock();

    for (const result of results)
        assert.strictEqual(result.success, true, JSON.stringify(result));

    const returnValues = results.map((result) => result.returnValue);
    assert.strictEqual(new Set(returnValues).size, 1);
    for (const returnValue of returnValues)
        assert.deepStrictEqual(JSON.parse(returnValue), EXPECTED);

    const snapshots = frames.filter((frame) => frame.type === 'snapshot');
    assert.strictEqual(snapshots.length, 2);

    const executeFrames = frames.filter((frame) => frame.type === 'execute');
    assert.strictEqual(executeFrames.length, 4);
    assert.deepStrictEqual(executeFrames[0].opts.crossChainData, SNAPSHOT);
    const snapshotTokens = [snapshots[0].token, snapshots[0].token, snapshots[1].token];
    for (const [index, frame] of executeFrames.slice(1).entries()) {
        assert.deepStrictEqual(frame.opts.crossChainData,
            { __xchainWorkerSnapshot: snapshotTokens[index] });
        assert.strictEqual(JSON.stringify(frame).includes('abcd'), false);
    }

    assert.deepStrictEqual(frames.map((frame) => frame.type), [
        'execute',
        'beginBlock', 'snapshot', 'execute', 'execute', 'endBlock',
        'beginBlock', 'snapshot', 'execute', 'endBlock'
    ]);
}

function snapshotAccessorTests() {
    this.timeout(30000);

    afterEach(cleanUpExecutor);
    it('preserves isSettled and getCallResult across snapshot-backed worker execution',
        preservesSnapshotBackedAccessorsAcrossWorkerChannel);
}

(S.HAVE_IVM ? describe : describe.skip)('process executor snapshot accessors',
    snapshotAccessorTests);
