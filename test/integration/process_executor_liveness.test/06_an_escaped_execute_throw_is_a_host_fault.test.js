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
const path = require('path');
const ProcessExecutor = require('../../../src/process-executor.js');
const { HostFaultError } = require('../../../src/errors.js');

const GAS_CEILING = 1000000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (predicate()) return true;
        await sleep(10);
    }
    return predicate();
}

function track(promise) {
    const tracked = { state: 'pending', value: undefined };
    promise.then(
        (value) => { tracked.state = 'resolved'; tracked.value = value; },
        (error) => { tracked.state = 'rejected'; tracked.value = error; });
    return tracked;
}

async function withThrowingWorker(fn) {
    const savedArgv = process.execArgv;
    const savedEnv = process.env.XVM_TEST_EXECUTE_THROW;
    process.execArgv = savedArgv.concat([
        '--require', path.join(__dirname, 'support', 'execute_throw_preload.js')]);
    process.env.XVM_TEST_EXECUTE_THROW = '1';
    try { return await fn(); }
    finally {
        process.execArgv = savedArgv;
        if (savedEnv === undefined) delete process.env.XVM_TEST_EXECUTE_THROW;
        else process.env.XVM_TEST_EXECUTE_THROW = savedEnv;
    }
}

function execution(network) {
    return {
        network,
        contractAddress: 'C:BTC:1',
        blockContext: { height: 100 }
    };
}

describe('process_executor liveness: gated escaped execute throw', function () {
    this.timeout(60000);

    it('rejects as a host fault and keeps the worker available', async function () {
        await withThrowingWorker(async () => {
            const exec = new ProcessExecutor({ gasCeiling: GAS_CEILING, limits: { maxCpuTimeMs: 5000 } });
            exec.beginBlock();
            try {
                assert.ok(await waitFor(() => exec._child && exec._sawReady, 10000),
                    'worker did not become ready');
                const worker = exec._child;
                const run = track(exec.execute(execution('regtest')));
                assert.ok(await waitFor(() => run.state !== 'pending', 10000),
                    'execution did not settle');
                assert.strictEqual(run.state, 'rejected', 'escaped throw resolved as a result');
                assert.ok(run.value instanceof HostFaultError, 'got ' + run.value);
                assert.strictEqual(run.value.code, 'EXECUTOR_UNAVAILABLE');
                assert.match(run.value.message, /injected execute throw/);
                assert.strictEqual(exec._child, worker, 'host-fault reply replaced the worker');
                assert.strictEqual(exec._sawReady, true, 'host-fault reply cleared worker readiness');

                const next = await exec.execute(execution('regtest'));
                assert.strictEqual(next.returnValue, '"r2"');
                assert.strictEqual(exec._child, worker, 'next execution did not use the same worker');
            } finally { await exec.shutdown(); }
        });
    });
});
