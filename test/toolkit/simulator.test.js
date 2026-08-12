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
 * Toolkit: ContractSimulator end-to-end. Needs the isolated-vm binding, so
 * the require is guarded: on a host where it cannot dlopen (e.g. macOS dev
 * box) the suite SKIPS (mirrors the VM smoke-suite convention) instead of
 * crash-spamming. Runs for real on Node 22 / Linux (CI).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

// Guard the require itself: simulator.js -> src/index.js -> isolated-vm.
let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const COUNTER = `
module.exports = {
    initialize: function(xchain) {
        var start = xchain.getInputParam(0);
        if (start === null || start === undefined) start = '0';
        xchain.state.set('count', start);
        return start;
    },
    increment: function(xchain) {
        var by = xchain.getInputParam(0) || '1';
        xchain.require(xchain.math.gt(by, '0'), 'must be positive');
        var next = xchain.math.add(xchain.state.get('count') || '0', by);
        xchain.state.set('count', next);
        return next;
    },
    get: function(xchain) { return xchain.state.get('count') || '0'; }
};`;

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

    it('deploys, runs the constructor, and reads state back', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['5'] });
            assert.strictEqual(dep.initResult.success, true);
            const res = await sim.call(dep.contractIndex, 'get', []);
            assert.strictEqual(JSON.parse(res.returnValue), '5');
        } finally { await sim.close(); }
    });

    it('persists committed state across calls (in-memory indexer mock)', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['0'] });
            await sim.call(dep.contractIndex, 'increment', ['3']);
            const res = await sim.call(dep.contractIndex, 'increment', ['4']);
            assert.strictEqual(JSON.parse(res.returnValue), '7');
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'count'), '7');
            assert(res.gasUsed > 0);
        } finally { await sim.close(); }
    });

    it('does not commit state on revert (atomicity)', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(COUNTER, { constructorParams: ['2'] });
            const before = sim.getStateValue(dep.contractIndex, 'count');
            const res = await sim.call(dep.contractIndex, 'increment', ['0']);
            assert.strictEqual(res.success, false);
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'count'), before);
        } finally { await sim.close(); }
    });

    it('exposes seeded balances to getBalance', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        sim.setBalance('alice', 'GOLD', '1000');
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ return xchain.getBalance("alice","GOLD"); };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '1000');
        } finally { await sim.close(); }
    });

    it('exposes seeded oracle prices to oracle.getPrice', async function() {
        const sim = new ContractSimulator();
        sim.setPrice('BTC/USD', '65000');
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ var p = xchain.oracle.getPrice("BTC/USD"); return p ? String(p.price) : "none"; };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '65000');
        } finally { await sim.close(); }
    });

    it('captures emitted actions without applying them to the ledger', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ xchain.emit.send({ destination: "bob", tick: "GOLD", quantity: "10" }); return "sent"; };');
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.emittedActions.length, 1);
            assert.strictEqual(res.emittedActions[0].action, 'SEND');
            // ledger untouched: getBalance still reads only what was seeded (nothing)
            assert.strictEqual(sim.getBalance('bob', 'GOLD'), null);
        } finally { await sim.close(); }
    });

    it('advances blocks and threads the new block context', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(
                'module.exports = function(xchain){ return String(xchain.getBlockHeight()); };');
            const r1 = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(r1.returnValue), '1');
            sim.advanceBlock();
            const r2 = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(r2.returnValue), '2');
        } finally { await sim.close(); }
    });

    it('runs a TypeScript contract via the strip step', async function() {
        const sim = new ContractSimulator();
        try {
            const ts = 'module.exports = function(xchain: any): string { const n: string = "42"; xchain.state.set("v", n); return n; };';
            const dep = await sim.deploy(ts, { filename: 'c.ts' });
            const res = await sim.call(dep.contractIndex, 'default', []);
            assert.strictEqual(JSON.parse(res.returnValue), '42');
            assert.strictEqual(sim.getStateValue(dep.contractIndex, 'v'), '42');
        } finally { await sim.close(); }
    });
});
