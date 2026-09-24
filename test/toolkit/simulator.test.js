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
    meta: { name: 'Counter', description: 'A persisted counter' },
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
        // alice is the caller, one of the two addresses a node's snapshot carries.
        const sim = new ContractSimulator({ coin: 'BTC', defaultCaller: 'alice' });
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

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

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

    it('reports the mainnet deploy verdict and rejects banned syntax again at call time', async function() {
        // This gate is what surfaces a chain-rejected source at DEPLOY, where the
        // author sees it. The 2026-09-09 ruling armed EXEC_LINT_ACTIVATION on mainnet,
        // so a mainnet simulator now re-lints at call() time too, but only for a source
        // that is actually called; a deploy-rejected source that is never called stays
        // silent without this gate. The case asserted here is the readable one because
        // banned-math also strips Math.sqrt, so the rejection is observable either way.
        const sim = new ContractSimulator({
            coin: 'BTC', network: 'mainnet', block: { height: 0 }
        });
        const warned = [];
        const real = console.warn;
        console.warn = (...a) => warned.push(a.join(' '));
        try {
            const dep = await sim.deploy(
                'module.exports = { run: function(xchain){ return String(Math.sqrt(4)); } };');
            assert.strictEqual(dep.deployGate.valid, false,
                'a mainnet simulator must still report the banned-math deploy rejection');
            assert.match(String(dep.deployGate.error), /Math\.sqrt/);
            // Advisory by design: the contract is still registered, so a fixture that
            // deliberately simulates a chain-rejected source keeps working.
            assert.strictEqual(sim.contracts.size, 1);
            const res = await sim.call(dep.contractIndex, 'run', []);
            assert.strictEqual(res.success, false);
            assert.match(String(res.error), /^error: banned syntax: .*Math\.sqrt/);
            // Warned once, not once per deploy.
            await sim.deploy(
                'module.exports = { run: function(xchain){ return String(Math.pow(2, 3)); } };');
            const gateWarnings = warned.filter((l) => /DEPLOY gate rejects/.test(l));
            assert.strictEqual(gateWarnings.length, 1, JSON.stringify(warned));
        } finally { console.warn = real; await sim.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

    it('passes a clean contract through the deploy gate on both networks', async function() {
        const dflt = new ContractSimulator();
        const main = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        try {
            for (const sim of [dflt, main]) {
                const dep = await sim.deploy(COUNTER, { constructorParams: ['1'] });
                assert.deepStrictEqual(dep.deployGate, { valid: true });
                assert.strictEqual(dep.initResult.success, true, dep.initResult.error);
            }
        } finally { await dflt.close(); await main.close(); }
    });

    it('resolves the gate flags at the configured epoch, not hardcoded on', async function() {
        // The point of resolving from (network, coin, block) rather than passing
        // literal `true`: a mainnet simulator pinned BELOW the Pkg-3 activation must
        // accept a source whose only violation rides that unarmed gate, exactly as
        // the chain accepted it at that height. Hardcoding the flags would reject it
        // and teach the author their historical contract was never deployable.
        const WASM = 'module.exports = { meta: { name: "Wasm probe", description: "Reads WebAssembly" }, ' +
            'probe: function(xchain){ return typeof WebAssembly; } };';
        const pre = new ContractSimulator({ coin: 'BTC', network: 'mainnet', block: { height: 1 } });
        const at  = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const real = console.warn;
        console.warn = () => {};
        try {
            assert.strictEqual((await pre.deploy(WASM)).deployGate.valid, true,
                'below the Pkg-3 height the banned-wasm rule is not enforced on chain either');
            const atGate = await at.deploy(WASM);
            assert.strictEqual(atGate.deployGate.valid, false,
                'at the armed height the chain rejects WebAssembly at deploy');
            assert.match(String(atGate.deployGate.error), /WebAssembly/);
        } finally { console.warn = real; await pre.close(); await at.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

    it('resolves banned-rest from the REST_PATTERN_METER flag-day, not unconditionally', async function() {
        // The deploy gate omitted enforceBannedRest entirely, and syntax.js defaults
        // every enforce* flag to ON, so a mainnet simulator pinned below the flag-day
        // rejected a rest parameter the chain at that timestamp accepts. Both the
        // execute-time re-lint (src/index.js) and the indexer deploy action resolve
        // the flag from isRestPatternMeterActive; this pins the gate to the same
        // predicate on both sides of the activation.
        const XChainVM = require('../../src/index.js');
        const GATE = XChainVM.REST_PATTERN_METER_GATE_BLOCK_TIME;
        const REST = 'module.exports = { meta: { name: "Rest probe", description: "Counts rest params" }, ' +
            'run: function(xchain, ...rest){ return String(rest.length); } };';
        const pre = new ContractSimulator({ coin: 'BTC', network: 'mainnet', block: { timestamp: GATE - 1 } });
        const at  = new ContractSimulator({ coin: 'BTC', network: 'mainnet', block: { timestamp: GATE } });
        const real = console.warn;
        console.warn = () => {};
        try {
            assert.strictEqual((await pre.deploy(REST)).deployGate.valid, true,
                'one second below the flag-day the chain does not enforce banned-rest either');
            const atGate = await at.deploy(REST);
            assert.strictEqual(atGate.deployGate.valid, false,
                'at the flag-day the chain rejects an unmeterable rest pattern at deploy');
            assert.match(String(atGate.deployGate.error), /rest/i);
        } finally { console.warn = real; await pre.close(); await at.close(); }
    });

});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator', function() {
    this.timeout(30000);

    it('pins the exact deploy-gate option key set deployGateVerdict builds', async function() {
        // Twin of the execute() drift guard below. enforceBannedRest was missing from
        // this set and nothing went red, because an omitted key reads as `true`
        // rather than as an error. A flag added to the indexer's
        // deploy call site and missed here must break this test, not stay invisible.
        const EXPECTED = [
            'enforceBannedAsync', 'enforceBannedGenerator', 'enforceBannedRest',
            'enforceBannedWasm', 'enforceLintGlobalAlias', 'enforceLintHardening'
        ].sort();
        const sim = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const seen = [];
        const real = sim.vm.validateSyntax.bind(sim.vm);
        sim.vm.validateSyntax = (src, opts) => { seen.push(Object.keys(opts).sort()); return real(src, opts); };
        try {
            await sim.deploy('module.exports = function(){ return "x"; };');
            assert.deepStrictEqual(seen[0], EXPECTED, 'deploy-gate option set drifted');
        } finally { sim.vm.validateSyntax = real; await sim.close(); }
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
