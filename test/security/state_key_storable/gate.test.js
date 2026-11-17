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
 * Storable state-key gate.
 *
 * The indexer stores state keys in contract_state.state_key, VARCHAR(256) in utf8mb3.
 * A key over 256 characters, or one holding a code point above U+FFFF, passed the VM
 * and then failed the indexer's INSERT, halting every indexer at that block. The refusal
 * is gated per network by STATE_KEY_STORABLE_ACTIVATION: regtest runs it from genesis,
 * testnet from its armed instant, and mainnet and unknown networks stay unarmed, where
 * status, gasUsed and error text are what they were before the gate existed.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const KEYS = {
    'a 257-character': { expr: "'a'.repeat(257)", text: 'state key exceeds max length (256 characters)' },
    'an astral': { expr: "'k' + String.fromCharCode(0xD83D, 0xDE00)", text: 'state key contains a code point above U+FFFF' },
};
const writeKey = (keyExpr) => `module.exports = function(xchain) {
    xchain.state.set(${keyExpr}, 'v');
    return 'wrote';
};`;
const catchKey = (keyExpr) => `module.exports = function(xchain) {
    try { xchain.state.set(${keyExpr}, 'v'); } catch (e) { xchain.state.set('err', e.message); }
    return 'ok';
};`;
const preArmTestnet = () => ({ ...LATE, timestamp: XChainVM.STATE_KEY_STORABLE_ACTIVATION.testnet - 1 });
const armedTestnet = () => ({ ...LATE, timestamp: XChainVM.STATE_KEY_STORABLE_ACTIVATION.testnet });

// One VM per test, opened and closed around it.
function withVm() {
    const ctx = {};
    beforeEach(function () { ctx.vm = createVM(); ctx.vm.beginBlock(); });
    afterEach(function () { if (ctx.vm && ctx.vm.endBlock) ctx.vm.endBlock(); });
    ctx.run = (code, network, blockContext) =>
        execute(ctx.vm, code, { method: 'default', network, blockContext: blockContext || LATE });
    return ctx;
}

// A run on its own new VM, so two runs compared for gasUsed share no warm state.
async function freshRun(code, network, blockContext) {
    const vm = createVM();
    vm.beginBlock();
    try {
        return await execute(vm, code, { method: 'default', network, blockContext });
    } finally {
        if (vm.endBlock) vm.endBlock();
    }
}

describe('state key storable gate: activation table', function () {
    it('is sealed, unarmed on mainnet, armed on testnet at 2026-11-17T00:00Z and active from regtest genesis', function () {
        const table = XChainVM.STATE_KEY_STORABLE_ACTIVATION;
        assert.ok(Object.isSealed(table));
        assert.deepStrictEqual({ ...table }, { mainnet: null, testnet: 1794873600, regtest: 0 });
        const active = XChainVM.isStateKeyStorableActive;
        assert.strictEqual(active('mainnet', LATE.timestamp), false);
        assert.strictEqual(active('unknown', LATE.timestamp), false);
        assert.strictEqual(active(undefined, LATE.timestamp), false);
        assert.strictEqual(active('testnet', 1794873599), false);
        assert.strictEqual(active('testnet', 1794873600), true);
        assert.strictEqual(active('testnet', NaN), false);
        assert.strictEqual(active('regtest', 0), true);
        assert.strictEqual(active('regtest', NaN), true);
    });
});

describe('state key storable gate: gate off', function () {
    this.timeout(30000);
    const ctx = withVm();

    for (const id of Object.keys(KEYS)) {
        it(`${id} key still succeeds and is written on every unarmed network`, async function () {
            const code = writeKey(KEYS[id].expr);
            const runs = {
                mainnet: await ctx.run(code, 'mainnet'),
                unknown: await ctx.run(code, 'unknown'),
                undefined: await ctx.run(code, undefined),
                testnet: await ctx.run(code, 'testnet', preArmTestnet()),
            };
            for (const [network, r] of Object.entries(runs)) {
                assert.strictEqual(r.success, true, `${network}: ${r.error}`);
                assert.strictEqual(r.error, null, network);
                assert.strictEqual(r.stateChanges.length, 1, network);
                assert.strictEqual(r.stateChanges[0].value, 'v', network);
            }
        });
    }
});

describe('state key storable gate: gate on', function () {
    this.timeout(30000);
    const ctx = withVm();

    for (const id of Object.keys(KEYS)) {
        it(`${id} key fails with the exact text on regtest and armed testnet`, async function () {
            for (const [network, block] of [['regtest', LATE], ['testnet', armedTestnet()]]) {
                const r = await ctx.run(writeKey(KEYS[id].expr), network, block);
                assert.strictEqual(r.success, false, network);
                assert.ok(String(r.error).includes(KEYS[id].text), `${network}: ${r.error}`);
                assert.deepStrictEqual(r.stateChanges, [], network);
                const caught = await ctx.run(catchKey(KEYS[id].expr), network, block);
                assert.strictEqual(caught.success, true, `${network}: ${caught.error}`);
                assert.deepStrictEqual(caught.stateChanges, [{ key: 'err', value: KEYS[id].text }], network);
            }
        });
    }

    it('a key that fits the column runs the same on both sides of the gate', async function () {
        for (const expr of ["'a'.repeat(255) + '中'", "'中'.repeat(256)"]) {
            const code = writeKey(expr);
            const off = await freshRun(code, 'testnet', preArmTestnet());
            const on = await freshRun(code, 'testnet', armedTestnet());
            assert.strictEqual(on.success, true, on.error);
            assert.strictEqual(off.success, on.success);
            assert.strictEqual(off.gasUsed, on.gasUsed);
            assert.deepStrictEqual(off.stateChanges, on.stateChanges);
        }
    });

    it('leaves delete of a long or astral key unrefused', async function () {
        const code = `module.exports = function(xchain) {
            xchain.state.delete('a'.repeat(300));
            xchain.state.delete('k' + String.fromCharCode(0xD83D, 0xDE00));
            return 'ok';
        };`;
        const r = await ctx.run(code, 'regtest');
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.stateDeletes, []);
    });
});
