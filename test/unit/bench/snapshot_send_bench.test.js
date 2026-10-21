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

const assert = require('assert');
let HAVE_IVM = true;
try { require('isolated-vm'); } catch (e) { HAVE_IVM = false; }

const { makeSnapshot, run } = require('../../../bench/scenarios/snapshot_send.js');

const EXECUTIONS = 4;
const BLOCKS = 2;

function assertFiniteMs(value) {
    assert.ok(Number.isFinite(value) && value >= 0, 'bad timing: ' + value);
}

function snapshotShape() {
    const snapshot = makeSnapshot(3);
    assert.deepStrictEqual(snapshot.attestations, {});
    assert.deepStrictEqual(Object.keys(snapshot.settled), ['BTC:0', 'BTC:1', 'BTC:2']);
    assert.strictEqual(snapshot.settled['BTC:2'], true);
    assert.deepStrictEqual(snapshot.calls['0000000a'], undefined);
    assert.deepStrictEqual(snapshot.calls['00000002'], { status: 'ok', payload: 'p2' });
}

async function reportsFramesAndTimings() {
    const out = await run({ sizes: [10, 200], executions: EXECUTIONS, blocks: BLOCKS });
    assert.strictEqual(out.results.length, 2);
    for (const r of out.results) {
        assert.strictEqual(r.bytes, Buffer.byteLength(JSON.stringify(makeSnapshot(r.entries))));
        assert.strictEqual(r.inline.snapshotFrames, 0);
        assert.strictEqual(r.inline.executeFramesWithSnapshot, EXECUTIONS);
        assert.strictEqual(r.perBlock.snapshotFrames, BLOCKS);
        assert.strictEqual(r.perBlock.executeFramesWithSnapshot, 0);
        for (const ms of [r.inline.ms, r.inline.perExecMs, r.perBlock.ms, r.perBlock.perBlockMs]) {
            assertFiniteMs(ms);
        }
    }
}

function snapshotSendBenchTests() {
    this.timeout(60000);

    it('makeSnapshot builds settled and calls maps for each entry', snapshotShape);
    it('counts snapshot frames and execute frames carrying the snapshot, around beginBlock',
        reportsFramesAndTimings);
}

(HAVE_IVM ? describe : describe.skip)('snapshot send bench', snapshotSendBenchTests);
