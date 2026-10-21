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
 * Pins the frames ProcessExecutor sends its worker today: a block of two
 * executes sharing one crossChainData snapshot carries that snapshot inside
 * each execute frame and nowhere else.
 ********************************************************************/
// @ts-nocheck

const S = require('../../integration/process_executor.test/support/executor_setup.js');
const ProcessExecutor = require('../../../src/process-executor.js');

const assert = S.assert;
const CODE = "module.exports = function(){ return xchain.crossChain.getAttestation('BTC', 7); };";
const SNAPSHOT_KEYS = ['attestations', 'settled', 'calls'];

function fixture() {
    return {
        attestations: { 'BTC:7': 'attested-value-7' },
        settled: { 'BTC:7': true },
        calls: { abcd: { status: 'ok', payload: 'p' } }
    };
}

function newExec() {
    return new ProcessExecutor({ gasSchedule: S.GAS_SCHEDULE, gasCeiling: S.GAS_CEILING, limits: S.LIMITS });
}

async function waitReady(exec) {
    const end = Date.now() + 15000;
    while (!exec._sawReady && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.ok(exec._sawReady, 'worker never became ready');
}

// Record a JSON copy of every frame the executor sends its worker.
function recordFrames(exec) {
    const frames = [];
    const child = exec._child;
    const realSend = child.send.bind(child);
    child.send = function (msg, ...rest) {
        frames.push(JSON.parse(JSON.stringify(msg)));
        return realSend(msg, ...rest);
    };
    return frames;
}

function executeOpts() {
    return Object.assign({}, S.BASE, { code: CODE, crossChainData: fixture() });
}

async function driveBlock(exec) {
    exec.beginBlock();
    const first = await exec.execute(executeOpts());
    const second = await exec.execute(executeOpts());
    exec.endBlock();
    return [first, second];
}

function containsSnapshot(frame) {
    return JSON.stringify(frame).includes(JSON.stringify(fixture().attestations));
}

(S.HAVE_IVM ? describe : describe.skip)('process executor snapshot send baseline', function () {
    this.timeout(30000);
    let exec, frames, results;

    beforeEach(async function () {
        exec = newExec();
        await waitReady(exec);
        frames = recordFrames(exec);
        results = await driveBlock(exec);
    });

    afterEach(async function () { await exec.shutdown(); });

    it('both executes succeed with the attested value', function () {
        for (const r of results) {
            assert.strictEqual(r.success, true, JSON.stringify(r));
            assert.strictEqual(JSON.parse(r.returnValue), 'attested-value-7');
        }
    });

    it('sends exactly beginBlock, execute, execute, endBlock', function () {
        assert.deepStrictEqual(frames.map((f) => f.type), ['beginBlock', 'execute', 'execute', 'endBlock']);
    });

    it('each execute frame carries the full snapshot in opts.crossChainData', function () {
        for (const f of frames.filter((x) => x.type === 'execute')) {
            assert.deepStrictEqual(f.opts.crossChainData, fixture());
        }
    });

    it('only the two execute frames contain the snapshot bytes', function () {
        assert.deepStrictEqual(frames.map(containsSnapshot), [false, true, true, false]);
    });

    it('an execute frame has the keys type, id, token, opts in that order', function () {
        const f = frames.find((x) => x.type === 'execute');
        assert.deepStrictEqual(Object.keys(f), ['type', 'id', 'token', 'opts']);
    });

    it('the snapshot keys are attestations, settled and calls in that order', function () {
        const f = frames.find((x) => x.type === 'execute');
        assert.deepStrictEqual(Object.keys(f.opts.crossChainData), SNAPSHOT_KEYS);
    });
});
