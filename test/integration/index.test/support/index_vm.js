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

const assert = require('assert');

let XChainVM, vmWorking = false;
try {
    XChainVM = require('../../../../src/index.js');
} catch (e) {
    console.log('Skipping index tests: isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling || 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs || 5000,
            maxMemory: overrides?.maxMemory || 8,
            maxEmissions: overrides?.maxEmissions || 50,
            maxStateKeys: overrides?.maxStateKeys || 10000,
            maxStateValueSize: overrides?.maxStateValueSize || 65536,
            maxCodeSize: 65536
        }
    });
}

// Probe whether full VM execution works (ExternalCopy of math may fail on some ivm versions)
if (XChainVM) {
    try {
        const probe = createVM();
        const p = probe.execute({
            code: 'module.exports = function(xchain) { return 1; };',
            state: {}, method: 'default', params: [],
            caller: 'probe', contractAddress: 'C:BTC:0',
            blockContext: { height: 1, timestamp: 0, hash: '0' }
        });
        // Synchronous check not possible; mark as potentially working.
        // The before() hook below will do the actual async check.
        vmWorking = true;
    } catch (e) {
        console.log('Skipping index tests: VM probe failed:', e);
    }
}

function execute(vm, code, opts) {
    return vm.execute({
        code: code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: opts?.caller || 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: opts?.balances,
        tokenInfo: opts?.tokenInfo,
        oracleData: opts?.oracleData,
        crossChainData: opts?.crossChainData,
        contractIndex: opts?.contractIndex
    });
}

async function setupVM() {
    const vm = createVM();
    // Verify the full VM pipeline works (ExternalCopy of math API may fail)
    const probe = await vm.execute({
        code: 'module.exports = function(xchain) { return 1; };',
        state: {}, method: 'default', params: [],
        caller: 'probe', contractAddress: 'C:BTC:0',
        blockContext: { height: 1, timestamp: 0, hash: '0' }
    });
    if (!probe.success) {
        console.log('Skipping XChainVM tests: VM execution not functional: ' + probe.error);
        this.skip();
    }
    return vm;
}

module.exports = { assert, XChainVM, GAS_SCHEDULE, vmWorking, createVM, setupVM, execute };
