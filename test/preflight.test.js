/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Preflight
 *
 * The rest of the suite guards isolate-dependent tests behind
 * `(XChainVM ? describe : describe.skip)` so a single focused run
 * doesn't crash-spam when the native engine can't load. The cost of
 * that ergonomics choice is a FALSE GREEN: if isolated-vm fails to
 * dlopen (e.g. the compiled binary's V8 ABI doesn't match the running
 * Node), every security / fuzz / chaos / e2e file silently becomes
 * `pending` and the run still reports success.
 *
 * This preflight is the antidote. It does a HARD require + a trivial
 * execute with NO try/catch. If the engine can't load, this fails
 * loudly and turns the whole run red. It is wired into `npm test` and
 * picked up by the `test/**` glob in `test:all`, so the primary CI
 * gates cannot pass while the sandbox is untested.
 *
 * If this fails with ERR_DLOPEN_FAILED + "undefined symbol", the
 * isolated-vm binary was built against a different Node/V8 than the
 * one running the tests. Fix: `npm rebuild isolated-vm --build-from-source`
 * on the Node version pinned in .nvmrc (matches the prod node:22 image).
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');

describe('Preflight: sandbox engine must load', function() {
    it('loads the XChainVM engine (isolated-vm native binding)', function() {
        // No try/catch on purpose — a load failure MUST fail the suite,
        // never skip it.
        const XChainVM = require('../src/index.js');
        assert.strictEqual(typeof XChainVM, 'function',
            'src/index.js should export the XChainVM constructor');
    });

    it('executes a trivial contract end-to-end inside the isolate', async function() {
        this.timeout(30000);
        const XChainVM = require('../src/index.js');
        const vm = new XChainVM({
            gasSchedule: {
                VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
                VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
                VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000,
            },
            gasCeiling: 1000000,
            limits: {
                maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
                maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536,
            },
        });
        vm.beginBlock();
        const result = await vm.execute({
            code:            'module.exports = function(xchain) { return "ok"; };',
            state:           {},
            method:          'default',
            params:          [],
            caller:          'preflight_addr',
            contractAddress: 'C:BTC:PREFLIGHT',
            blockContext:    { height: 1, timestamp: 1700000000, hash: 'preflight_hash' },
        });
        vm.endBlock();
        assert.strictEqual(result.success, true,
            'trivial contract should execute successfully; error: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 'ok');
    });
});
