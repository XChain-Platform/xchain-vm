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

const MARKER = 'host-fault-halt-marker';
const CONTRACT = `module.exports = function () { return '${MARKER}'; };`;

async function run() {
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

    let rejection = null;
    vm.beginBlock();
    try {
        await vm.execute({
            code: CONTRACT,
            method: 'default',
            params: [],
            state: {},
            contractAddress: 'C:BTC:1',
            contractIndex: 1,
            network: 'regtest',
            blockContext: { height: 5 },
        });
    } catch (error) {
        rejection = error;
    } finally {
        vm.endBlock();
        await vm.shutdown();
    }

    return { compileThrows, rejection };
}

describe('compile fault at the host-fault halt gate', function () {
    this.timeout(60000);

    it('rejects a regtest wrapper compile throw as a HostFaultError', async function () {
        const observed = await run();

        assert.strictEqual(observed.compileThrows, 1);
        assert.ok(observed.rejection instanceof HostFaultError);
        assert.strictEqual(observed.rejection.message,
            'wrapper compilation failed: injected compile throw');
    });
});
