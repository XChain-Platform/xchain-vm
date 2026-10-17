// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
const { HostFaultError } = require('../../../src/errors.js');

const GAS_SCHEDULE = {
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

const MARKER = 'compile-fault-marker';
const CONTRACT = `module.exports = function () { return '${MARKER}'; };`;

async function run(network) {
    const vm = new XChainVM({
        execution: 'in-process',
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
    });
    const compileScript = vm.isolateManager.compileScript.bind(vm.isolateManager);
    let compileThrows = 0;

    vm.isolateManager.compileScript = (isolate, code, cachedData) => {
        if (String(code).includes(MARKER)) {
            compileThrows++;
            throw new Error('injected compile throw');
        }
        return compileScript(isolate, code, cachedData);
    };

    let result = null;
    let rejection = null;
    vm.beginBlock();
    try {
        result = await vm.execute({
            code: CONTRACT,
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

    return { compileThrows, result, rejection };
}

describe('compile fault below the halt gate', function () {
    this.timeout(60000);

    for (const network of ['mainnet', 'testnet']) {
        it(`${network} keeps a wrapper compile throw as a compilation failed result`, async function () {
            const observed = await run(network);

            assert.strictEqual(observed.compileThrows, 1);
            assert.strictEqual(observed.rejection instanceof HostFaultError, false);
            assert.strictEqual(observed.rejection, null);
            assert.strictEqual(observed.result.success, false);
            assert.strictEqual(observed.result.error,
                'error: compilation failed: injected compile throw');
            assert.strictEqual(observed.result.returnValue, null);
            assert.deepStrictEqual(observed.result.stateChanges, []);
        });
    }
});
