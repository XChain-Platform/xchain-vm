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
//
// 5bff4687 (flag-day Pkg 4 / ): post-VM_LINT_HARDENING the CONTRACT
// WRAPPER's control bindings (__contractCode/__methodName/__isCrossCall/
// __readManifest) are IIFE parameters, invisible to the Function-constructed
// contract body, so a contract can no longer read them to steer dispatch
// (deploy-side, lint-core also rejects any reference). Pre-gate the legacy
// script-level `let` form (readable from the contract) is preserved verbatim
// for replay parity.

'use strict';

const assert = require('assert');

let XChainVM = null;
try {
    XChainVM = require('../../src/index.js'); // requires isolated-vm (Node 22 / Linux)
} catch (e) { /* skipped below */ }

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Reads the wrapper's method-dispatch binding; deploy-linted away post-gate,
// but a pre-gate deploy could carry it, so the WRAPPER must starve it too.
const PEEK = 'module.exports = { peek: function(x) { return String(typeof __methodName) + ":" + String(typeof __isCrossCall); } };';

(XChainVM ? describe : describe.skip)('CONTRACT_WRAPPER control-binding closure move (5bff4687)', function () {

    function run(vm, network, timestamp) {
        return vm.execute({
            code: PEEK, state: {}, method: 'peek', params: [],
            caller: 'addr', contractAddress: 'C:BTC:TEST', network,
            blockContext: { height: 1, timestamp, hash: 'h' }
        });
    }

    let vm;
    beforeEach(function () {
        vm = new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process' });
        vm.beginBlock();
    });
    afterEach(function () { vm.endBlock(); });

    it('post-gate (regtest from genesis): the execute-time lint rejects the peek before the wrapper starves it', async function () {
        //  supersession. The wrapper's starvation of the control bindings is the
        // defence-in-depth layer for a contract that DEPLOYED before the reserved-identifier
        // rule armed. Where execute-time source-lint enforcement is active (the pre-launch
        // nets, from genesis), such a contract can no longer run at all: the stored source
        // is re-linted against the bans live at this block and fails first. The wrapper
        // starvation itself stays pinned below the exec-lint gate by the mainnet case below.
        const res = await run(vm, 'regtest', 1700000000);
        assert.strictEqual(res.success, false);
        assert.ok(res.error.startsWith('error: banned syntax: '), res.error);
        assert.ok(res.error.includes('__methodName'), res.error);
    });

    // The wrapper-starvation pin. Mainnet is below the  execute-time lint gate
    // (unarmed), so the stored source still reaches the wrapper and the closure move is
    // what has to starve it, exactly as before.
    it('post-gate (mainnet at the flag-day): bindings are starved there too', async function () {
        const res = await run(vm, 'mainnet', 1786060800);
        assert.strictEqual(res.success, true, res.error);
        assert.strictEqual(JSON.parse(res.returnValue), 'undefined:undefined');
    });

    it('pre-gate (mainnet below the flag-day): legacy visibility preserved for replay parity', async function () {
        const res = await run(vm, 'mainnet', 1786060799);
        assert.strictEqual(res.success, true, res.error);
        assert.strictEqual(JSON.parse(res.returnValue), 'string:boolean');
    });

    it('post-gate dispatch still works end-to-end (method routing unaffected)', async function () {
        const code = 'module.exports = { a: function(x) { return "A"; }, b: function(x) { return "B"; } };';
        for (const [method, want] of [['a', 'A'], ['b', 'B']]) {
            const res = await vm.execute({
                code, state: {}, method, params: [],
                caller: 'addr', contractAddress: 'C:BTC:TEST', network: 'regtest',
                blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
            });
            assert.strictEqual(res.success, true, res.error);
            assert.strictEqual(JSON.parse(res.returnValue), want);
        }
    });

    it('post-gate crossCallable gating still enforces (isCrossCall threads through the closure)', async function () {
        const code = 'module.exports = { open: function(x) { return 1; }, crossCallable: [] };';
        const res = await vm.execute({
            code, state: {}, method: 'open', params: [], isCrossCall: true,
            caller: 'addr', contractAddress: 'C:BTC:TEST', network: 'regtest',
            blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
        });
        assert.strictEqual(res.success, false);
        assert.ok(res.error.includes('XCALL_NOT_CALLABLE'), res.error);
    });

    it('post-gate manifest introspection still works (readManifest threads through the closure)', async function () {
        const code = 'module.exports = { m: function(x) { return 1; }, permissions: ["emit.send"], maxTakeBps: 25 };';
        const res = await vm.execute({
            code, state: {}, method: 'm', params: [], readManifest: true,
            caller: 'addr', contractAddress: 'C:BTC:TEST', network: 'regtest',
            blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
        });
        assert.strictEqual(res.success, true, res.error);
        const manifest = JSON.parse(res.returnValue);
        assert.deepStrictEqual(manifest.permissions, ['emit.send']);
        assert.strictEqual(manifest.maxTakeBps, 25);
    });
});
