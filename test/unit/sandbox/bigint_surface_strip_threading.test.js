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
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const sandbox = require('../../../src/sandbox.js');
const XChainVM = require('../../../src/index.js');
const identityPin = require('../../../bin/pins/identity.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function newVm() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        execution: 'in-process'
    });
}

const CONTEXT = { height: 10000000, timestamp: 1786060800, hash: 'b'.repeat(64) };
const PRE_PKG3_CONTEXT = { height: 960999, timestamp: 1700000000, hash: 'c'.repeat(64) };
const ADDRESS = 'C:BTC:1';

async function executeWithStripOptions(opts) {
    const original = sandbox.stripGlobals;
    const observed = [];
    sandbox.stripGlobals = function captureStripOptions(isolate, context, stripOptions) {
        observed.push({ ...stripOptions });
        return original(isolate, context, stripOptions);
    };
    try {
        return { result: await newVm().execute(opts), observed };
    } finally {
        sandbox.stripGlobals = original;
    }
}

async function assertParallelIsolation() {
    const code = "module.exports = function(){ return typeof BigInt64Array; };";
    const base = {
        code, state: {}, method: 'default', params: [], caller: 'bc1qcaller',
        contractAddress: ADDRESS, contractIndex: 1, txHash: 'a'.repeat(64)
    };
    const [armed, unarmed] = await Promise.all([
        newVm().execute({
            ...base, network: 'regtest',
            blockContext: { height: 0, timestamp: 0, hash: 'b'.repeat(64) }
        }),
        newVm().execute({ ...base, network: 'mainnet', blockContext: PRE_PKG3_CONTEXT })
    ]);

    assert.strictEqual(armed.success, true, armed.error);
    assert.strictEqual(unarmed.success, true, unarmed.error);
    assert.strictEqual(armed.returnValue, '"undefined"');
    assert.strictEqual(unarmed.returnValue, '"function"');
}

describe('BigInt surface strip execute threading', function () {
    it('matches the pinned companion SDK commit byte for byte', function () {
        const entry = identityPin.files['src/stripped-globals.js'];
        assert.match(entry.sdkCommit, /^[0-9a-f]{40}$/);
        const commonGitDir = childProcess.execFileSync(
            'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            { cwd: REPO_ROOT, encoding: 'utf8' }
        ).trim();
        const sdkRoot = path.resolve(commonGitDir, '..', '..', 'xchain-sdk');
        const sdkPath = entry.sdkPath.replace(/^xchain-sdk\//, '');
        const vendored = childProcess.execFileSync(
            'git', ['-C', sdkRoot, 'show', entry.sdkCommit + ':' + sdkPath]
        );

        assert.deepStrictEqual(vendored, fs.readFileSync(path.join(REPO_ROOT, 'src/stripped-globals.js')));
    });

    it('passes the unarmed map decision beside Package 3 compatibility', async function () {
        const { result, observed } = await executeWithStripOptions({
            code: "module.exports = function(){ return [typeof BigInt64Array, typeof BigUint64Array, typeof DataView.prototype.getBigInt64, typeof globalThis['Web' + 'Assembly']]; };",
            state: {}, method: 'default', params: [], caller: 'bc1qcaller',
            contractAddress: ADDRESS, contractIndex: 1, txHash: 'a'.repeat(64),
            blockContext: CONTEXT, network: 'mainnet'
        });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.returnValue, '["undefined","undefined","undefined","undefined"]');
        assert.strictEqual(observed.length, 1);
        assert.strictEqual(observed[0].stripWasm, true);
        assert.strictEqual(observed[0].stripBigIntSurface, false);
    });

    it('strips the surface on regtest from genesis', async function () {
        const { result, observed } = await executeWithStripOptions({
            code: "module.exports = function(){ return [typeof BigInt64Array, typeof BigUint64Array, typeof DataView.prototype.getBigInt64, typeof globalThis['Web' + 'Assembly']]; };",
            state: {}, method: 'default', params: [], caller: 'bc1qcaller',
            contractAddress: ADDRESS, contractIndex: 1, txHash: 'a'.repeat(64),
            blockContext: { height: 0, timestamp: 0, hash: 'b'.repeat(64) }, network: 'regtest'
        });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.returnValue, '["undefined","undefined","undefined","undefined"]');
        assert.strictEqual(observed.length, 1);
        assert.strictEqual(observed[0].stripBigIntSurface, true);
    });

    it('isolates armed and unarmed decisions across parallel executions', assertParallelIsolation);

    it('uses the deploy context for manifest execution', async function () {
        const code = "module.exports = { permissions: typeof BigInt64Array === 'undefined' ? ['SEND'] : [] };";
        const publicResult = await newVm().readManifest(code, {
            network: 'mainnet', contractAddress: ADDRESS, blockContext: PRE_PKG3_CONTEXT
        });
        const regtestResult = await newVm().readManifest(code, {
            network: 'regtest', contractAddress: ADDRESS,
            blockContext: { height: 0, timestamp: 0, hash: 'b'.repeat(64) }
        });

        assert.strictEqual(publicResult.success, true, publicResult.error);
        assert.strictEqual(regtestResult.success, true, regtestResult.error);
        assert.deepStrictEqual(publicResult.manifest.permissions, []);
        assert.deepStrictEqual(regtestResult.manifest.permissions, ['SEND']);
    });
});
