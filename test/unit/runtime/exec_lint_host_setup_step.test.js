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
 * Execute-time lint host-fault boundary
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROBE = String.raw`
'use strict';

const assert = require('assert');
const path = require('path');

const repoRoot = process.argv[1];
const network = process.argv[2];
const lintModule = require(path.join(repoRoot, 'src/index/runtime/exec_lint.js'));
const injectedError = new Error('injected lint throw');
lintModule.checkExecLint = () => { throw injectedError; };

const XChainVM = require(path.join(repoRoot, 'src/index.js'));
const { HostFaultError } = require(path.join(repoRoot, 'src/errors.js'));
const gasSchedule = {
    VM_COMPUTATION: 1,
    VM_STATE_READ: 100,
    VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000,
    VM_XCALL_CALLBACK: 20000,
};

(async () => {
    const vm = new XChainVM({
        execution: 'in-process',
        gasSchedule,
        gasCeiling: 1000000,
    });
    vm.beginBlock();

    let result;
    let rejection;
    try {
        result = await vm.execute({
            code: 'module.exports = function() { return 1; };',
            method: 'default',
            params: [],
            state: {},
            contractAddress: 'C:BTC:1',
            contractIndex: 1,
            network,
            blockContext: { height: 5 },
        });
    } catch (error) {
        rejection = error;
    } finally {
        vm.endBlock();
        await vm.shutdown();
    }

    assert.strictEqual(result, undefined, 'execute() must not settle with a result');
    if (network === 'regtest') {
        assert.ok(rejection instanceof HostFaultError);
        assert.strictEqual(rejection.message,
            'execution setup failed (checkExecLint): injected lint throw');
    } else {
        assert.strictEqual(rejection, injectedError, 'the below-gate throw must escape unchanged');
        assert.strictEqual(rejection instanceof HostFaultError, false);
    }
})().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
`;

describe('execute-time lint host-fault boundary', function() {
    this.timeout(30000);

    function runProbe(network) {
        execFileSync(process.execPath, ['-e', PROBE, REPO_ROOT, network], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 20000,
        });
    }

    it('wraps the lint throw on active regtest', function() {
        runProbe('regtest');
    });

    it('leaves the lint throw unchanged below the mainnet gate', function() {
        runProbe('mainnet');
    });
});
