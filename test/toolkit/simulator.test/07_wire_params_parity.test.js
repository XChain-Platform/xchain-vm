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
 * Toolkit: call() and deploy() hand a contract the arguments the chain hands it.
 * The indexer joins a method's or constructor's arguments with '|' and the VM
 * receives that string split back, so every argument is a string, a '|' inside
 * one splits it, and an empty join is zero arguments. Needs the isolated-vm
 * binding, so the require is guarded and the suite SKIPS where it cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    wireParams, callbackParams, isCallbackArgsExactActive, paramsReshaped, CALLBACK_ARGS_EXACT_TIMES
} = require('../../../src/toolkit/simulator/wire_params.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const META = 'meta: { name: "Wire probe", description: "Echoes the arguments it receives" }, ';
const PROBE = 'module.exports = { ' + META +
    'initialize: function(xchain){ xchain.state.set("ctor", JSON.stringify(' +
    '[0, 1, 2].map(function(i){ return xchain.getInputParam(i); }))); return "ok"; }, ' +
    'echo: function(xchain){ return [0, 1, 2].map(function(i){' +
    ' var v = xchain.getInputParam(i); return [typeof v, v]; }); }, ' +
    'ctor: function(xchain){ return xchain.state.get("ctor"); } };';

async function withProbe(deployOpts, fn) {
    const sim = new ContractSimulator({ coin: 'BTC' });
    const real = console.warn;
    console.warn = () => {};
    try {
        const dep = await sim.deploy(PROBE, deployOpts || {});
        return await fn(sim, dep);
    } finally { console.warn = real; await sim.close(); }
}

async function echo(params, callOpts, simOpts) {
    return withProbe({}, async (sim, dep) => {
        if (simOpts) sim.network = simOpts.network;
        const res = await sim.call(dep.contractIndex, 'echo', params, callOpts || {});
        assert.strictEqual(res.success, true, res.error);
        return JSON.parse(res.returnValue);
    });
}

describe('Toolkit wireParams', function() {
    it('splits the joined wire string and reads empty as zero arguments', function() {
        assert.deepStrictEqual(wireParams(undefined), []);
        assert.deepStrictEqual(wireParams(null), []);
        assert.deepStrictEqual(wireParams([]), []);
        assert.deepStrictEqual(wireParams(['']), []);
        assert.deepStrictEqual(wireParams(''), []);
        assert.deepStrictEqual(wireParams(['', '']), ['', '']);
        assert.deepStrictEqual(wireParams('alice|100'), ['alice', '100']);
        assert.deepStrictEqual(wireParams(['a|b', 5, null]), ['a', 'b', '5', '']);
    });
});

describe('Toolkit callbackParams', function() {
    const AFTER = 1792303200;

    it('keeps a pipe inside one element once CALLBACK_ARGS_EXACT is armed', function() {
        assert.deepStrictEqual(callbackParams(['a|b', 5, null], 'testnet', AFTER), ['a|b', '5', '']);
        assert.deepStrictEqual(callbackParams([''], 'regtest', 0), ['']);
        assert.deepStrictEqual(callbackParams([], 'regtest', 0), []);
    });

    it('runs on the wire form below the flag and on mainnet, where it is unarmed', function() {
        assert.deepStrictEqual(callbackParams(['a|b'], 'testnet', AFTER - 1), ['a', 'b']);
        assert.deepStrictEqual(callbackParams(['a|b'], 'mainnet', AFTER), ['a', 'b']);
        assert.deepStrictEqual(callbackParams(['a|b'], 'unnamed', AFTER), ['a', 'b']);
        assert.strictEqual(isCallbackArgsExactActive('regtest', 0), true);
        assert.strictEqual(isCallbackArgsExactActive('testnet', AFTER - 1), false);
    });

    it('reports a reshape only when the delivered arguments differ from the given ones', function() {
        assert.strictEqual(paramsReshaped(['a', 'b'], ['a', 'b']), false);
        assert.strictEqual(paramsReshaped([], []), false);
        assert.strictEqual(paramsReshaped([5], ['5']), true);
        assert.strictEqual(paramsReshaped(['a|b'], ['a', 'b']), true);
        assert.strictEqual(paramsReshaped([''], []), true);
    });
});

describe('simulator callback gate agrees with the indexer registry row', function() {
    it('arms CALLBACK_ARGS_EXACT at the instants of the changes_5.js row', function() {
        const root = path.resolve(__dirname, '..', '..', '..', '..');
        const rel = path.join('xchain-indexer', 'src', 'protocol_changes', 'changes_5.js');
        const verdict = siblingCheckout(__dirname, path.join(root, rel));
        if (!skipOrFail(this, verdict, 'callback gate parity (' + rel + ')')) return;
        const src = fs.readFileSync(verdict.path, 'utf8');
        const row = src.match(/\['CALLBACK_ARGS_EXACT',\s*'[^']*',\s*(UNARMED|\d+),\s*(\d+),\s*regtestTimeOverride\('CALLBACK_ARGS_EXACT_REGTEST_TIME'\)/);
        assert.ok(row, 'CALLBACK_ARGS_EXACT row not found in ' + rel + '; re-point this scrape');
        const unarmed = Number(fs.readFileSync(path.join(path.dirname(verdict.path), 'core.js'), 'utf8')
            .match(/const UNARMED = (\d+);/)[1]);
        assert.deepStrictEqual(Object.assign({}, CALLBACK_ARGS_EXACT_TIMES), {
            mainnet: row[1] === 'UNARMED' ? unarmed : Number(row[1]),
            testnet: Number(row[2]),
            regtest: 0
        }, 'the simulator arms callback arguments at a different instant than the chain');
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: wire params parity', function() {
    this.timeout(30000);

    it('delivers a numeric call argument as the string the chain delivers', async function() {
        const out = await echo([5]);
        assert.deepStrictEqual(out[0], ['string', '5']);
    });

    it('splits a pipe-bearing call argument into the arguments the chain delivers', async function() {
        const out = await echo(['a|b']);
        assert.deepStrictEqual(out.slice(0, 2), [['string', 'a'], ['string', 'b']]);
    });

    it('delivers an empty-string call argument as no argument', async function() {
        const out = await echo(['']);
        assert.deepStrictEqual(out[0], ['object', null]);
    });

    it('runs initialize with the split arguments of a string constructorParams', async function() {
        const seen = await withProbe({ constructorParams: 'alice|100' }, async (sim, dep) => {
            assert.strictEqual(dep.initResult.success, true, dep.initResult.error);
            const res = await sim.call(dep.contractIndex, 'ctor', []);
            return JSON.parse(JSON.parse(res.returnValue));
        });
        assert.deepStrictEqual(seen, ['alice', '100', null]);
    });

    it('keeps a pipe inside one callback argument on regtest, as the chain does', async function() {
        const out = await echo(['a|b', 'c'], { callback: true });
        assert.deepStrictEqual(out.slice(0, 2), [['string', 'a|b'], ['string', 'c']]);
    });

    it('splits a callback argument on a network where the flag is unarmed', async function() {
        const out = await echo(['a|b'], { callback: true }, { network: 'mainnet' });
        assert.deepStrictEqual(out.slice(0, 2), [['string', 'a'], ['string', 'b']]);
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: reshaped params warning', function() {
    this.timeout(30000);

    it('warns once when the arguments are reshaped and never for plain strings', async function() {
        const seen = [];
        const real = console.warn;
        const sim = new ContractSimulator({ coin: 'BTC' });
        try {
            console.warn = () => {};
            const dep = await sim.deploy(PROBE, {});
            console.warn = (m) => seen.push(String(m));
            await sim.call(dep.contractIndex, 'echo', ['a', 'b']);
            assert.strictEqual(seen.filter((m) => /reshaped/.test(m)).length, 0);
            await sim.call(dep.contractIndex, 'echo', [5]);
            await sim.call(dep.contractIndex, 'echo', ['x|y']);
            assert.strictEqual(seen.filter((m) => /reshaped/.test(m)).length, 1);
        } finally { console.warn = real; await sim.close(); }
    });

    it('delivers a pipe-bearing constructor element as separate arguments', async function() {
        const seen = await withProbe({ constructorParams: ['a|b', 7] }, async (sim, dep) => {
            const res = await sim.call(dep.contractIndex, 'ctor', []);
            return JSON.parse(JSON.parse(res.returnValue));
        });
        assert.deepStrictEqual(seen, ['a', 'b', '7']);
    });
});
