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

// These tests require isolated-vm. Skip if not available.
let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping sandbox tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code) {
    return vm.execute({
        code: code,
        state: {},
        method: 'default',
        params: [],
        caller: 'test_address',
        contractAddress: 'C:BTC:1',
        blockContext: { height: 100, timestamp: 1700000000, hash: 'abc123' }
    });
}

(XChainVM ? describe : describe.skip)('Sandbox', function() {

    let vm;
    before(function() { vm = createVM(); });

    // Gas/result determinism for the STRIP-PATH programs. The corpus
    // determinism suites (cache-determinism, golden.determinism) prove
    // cold/warm/fresh-VM equality only for compute/stateful programs; the
    // neutered surface (stripped globals, neutered constructors, frozen
    // SafeMath) was never in those corpora. These cases assert that the
    // strip path itself costs identical gas and returns identical bytes
    // warm, repeated, and on a fresh isolate. A failure here is a REAL
    // strip-path determinism bug, not a test problem; do not weaken it.
    describe('strip-path gas/result determinism', function() {
        const STRIP_PROGRAMS = {
            'process-access-blocked':
                'module.exports = function(xchain) { return typeof process; };',
            'Proxy-neutered':
                'module.exports = function(xchain) { return typeof Proxy; };',
            'Math.random-throws': `module.exports = function(xchain) {
                try { Math.random(); return 'ran'; } catch(e) { return 'blocked'; }
            };`,
            'constructor-escape-blocked': `module.exports = function(xchain) {
                try {
                    return this.constructor.constructor('return typeof process')();
                } catch(e) { return 'blocked'; }
            };`
        };

        for (const [name, code] of Object.entries(STRIP_PROGRAMS)) {
            it(name + ': gasUsed + returnValue identical warm, repeated, and on a fresh VM', async function() {
                const warm1 = await executeCode(vm, code);
                const warm2 = await executeCode(vm, code);
                const fresh = await executeCode(createVM(), code);
                for (const r of [warm1, warm2, fresh]) {
                    assert.strictEqual(r.success, true, name + ' must execute: ' + r.error);
                    assert.strictEqual(typeof r.gasUsed, 'number', name + ' must report numeric gasUsed');
                }
                assert.strictEqual(warm2.gasUsed, warm1.gasUsed,
                    name + ': repeated warm run must charge identical gas');
                assert.strictEqual(fresh.gasUsed, warm1.gasUsed,
                    name + ': fresh-VM run must charge identical gas');
                assert.strictEqual(warm2.returnValue, warm1.returnValue,
                    name + ': repeated warm run must return identical bytes');
                assert.strictEqual(fresh.returnValue, warm1.returnValue,
                    name + ': fresh-VM run must return identical bytes');
            });
        }
    });
});
