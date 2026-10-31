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
const { HostFaultError } = require('../../src/errors.js');
const { resolveWorkerCrossChainSnapshot } = require('../../src/process_executor/snapshot_channel.js');

const assert = S.assert;
const STALE = { __xchainWorkerSnapshot: 'stale-token' };
const CODE = `module.exports = function () {
    return xchain.crossChain.isSettled('BTC', 1);
};`;

// Check the resolver alone: no worker listener runs here, so every reference is stale.
describe('worker cross-chain snapshot reference mismatch', function () {
    it('raises a stale snapshot reference as a host fault', function () {
        let thrown = null;
        try { resolveWorkerCrossChainSnapshot(Object.assign({}, STALE)); } catch (e) { thrown = e; }
        assert.ok(thrown, 'a stale reference must not resolve');
        assert.ok(thrown instanceof HostFaultError,
            'a mismatch is worker-local state, so it must halt and retry, not commit a result');
    });

    it('passes a plain snapshot and null through unchanged', function () {
        const plain = { settled: {} };
        assert.strictEqual(resolveWorkerCrossChainSnapshot(plain), plain);
        assert.strictEqual(resolveWorkerCrossChainSnapshot(null), null);
    });
});

let exec;

async function waitReady() {
    const end = Date.now() + 15000;
    while (!exec._sawReady && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(exec._sawReady, 'worker never became ready');
}

// Record the reply types the worker sends back to the parent.
function captureReplies() {
    const replies = [];
    exec._child.on('message', (msg) => { if (msg && msg.type) replies.push(msg.type); });
    return replies;
}

(S.HAVE_IVM ? describe : describe.skip)('worker snapshot mismatch through the process executor', function () {
    this.timeout(30000);

    afterEach(async function () {
        if (exec) await exec.shutdown();
        exec = null;
    });

    it('rejects a stale snapshot reference with a host fault instead of an error result', async function () {
        exec = new ProcessExecutor({ gasSchedule: S.GAS_SCHEDULE, gasCeiling: S.GAS_CEILING, limits: S.LIMITS });
        await waitReady();
        const replies = captureReplies();
        // Outside a block the parent forwards crossChainData untouched, so the worker sees the stale token.
        let result = null;
        let thrown = null;
        try {
            result = await exec.execute(Object.assign({}, S.BASE, { code: CODE, crossChainData: Object.assign({}, STALE) }));
        } catch (e) { thrown = e; }
        assert.strictEqual(result, null, 'a host-local mismatch committed a result: ' + JSON.stringify(result));
        assert.ok(thrown instanceof HostFaultError, 'expected a HostFaultError, got ' + (thrown && thrown.name));
        assert.ok(replies.includes('hostfault'), 'worker replied ' + JSON.stringify(replies));
        assert.ok(!replies.includes('result'), 'worker replied ' + JSON.stringify(replies));
    });
});
