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
 * Toolkit: deploy() runs `initialize` under the indexer's constructor trigger
 * (DEPLOY_INIT_STRICT) and folds a failed constructor into deployGate with the
 * status the chain records. Needs the isolated-vm binding, so the require is
 * guarded and the suite SKIPS where it cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
let gate = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
    gate = require('../../../src/toolkit/simulator/manifest_gate.js');
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}
const { META_VERDICTS } = require('../../../src/toolkit/gate/meta_validation.js');

const STRICT_AT = 1786060800;
const META = 'meta: { name: "Ctor probe", description: "Exercises the deploy constructor" }, ';
const get = 'get: function(xchain){ return xchain.state.get("n") || "unset"; } ';
const ZERO_ARG = 'module.exports = { ' + META +
    'initialize: function(xchain){ xchain.state.set("n", "init"); return "init"; }, ' + get + '};';
const NEEDS_ARG = 'module.exports = { ' + META +
    'initialize: function(xchain){ var v = xchain.getInputParam(0); ' +
    'xchain.require(v !== null && v !== undefined && v !== "", "start required"); ' +
    'xchain.state.set("n", v); return v; }, ' + get + '};';
const NO_INIT = 'module.exports = { ' + META + get + '};';
const NO_META_FAILING = 'module.exports = { initialize: function(){ throw new Error("nope"); }, ' + get + '};';

// Deploy src on a fresh simulator, capture warnings, and read `get` back.
async function deployAndRead(src, simOpts, deployOpts) {
    const sim = new ContractSimulator(Object.assign({ coin: 'BTC' }, simOpts || {}));
    const warned = [];
    const real = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        const dep = await sim.deploy(src, deployOpts || {});
        const read = await sim.call(dep.contractIndex, 'get', []);
        return { dep, read: read.success ? JSON.parse(read.returnValue) : null, warned };
    } finally { console.warn = real; await sim.close(); }
}

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: deploy constructor parity', function() {
    this.timeout(30000);

    it('runs a zero-arg initialize with no constructor params, as the chain does', async function() {
        const { dep, read } = await deployAndRead(ZERO_ARG);
        assert.ok(dep.initResult, 'the constructor must run when the contract exports initialize');
        assert.strictEqual(dep.initResult.success, true, dep.initResult.error);
        assert.strictEqual(read, 'init');
        assert.deepStrictEqual(dep.deployGate, { valid: true });
    });

    it('rejects an arg-expecting initialize deployed with no params with the chain status', async function() {
        const { dep, read, warned } = await deployAndRead(NEEDS_ARG);
        assert.strictEqual(dep.initResult.success, false);
        assert.deepStrictEqual(dep.deployGate,
            { valid: false, error: 'invalid: constructor failed: ' + dep.initResult.error });
        assert.ok(warned.some((l) => l.includes('records `invalid: constructor failed: ')), JSON.stringify(warned));
        assert.strictEqual(read, 'unset', 'the contract stays registered and callable');
    });

    it('folds a failing constructor given explicit params into deployGate', async function() {
        const { dep } = await deployAndRead(NEEDS_ARG, {}, { constructorParams: [''] });
        assert.strictEqual(dep.initResult.success, false);
        assert.strictEqual(dep.deployGate.valid, false);
        assert.match(dep.deployGate.error, /^invalid: constructor failed: /);
        const ok = await deployAndRead(NEEDS_ARG, {}, { constructorParams: ['7'] });
        assert.strictEqual(ok.read, '7');
        assert.deepStrictEqual(ok.dep.deployGate, { valid: true });
    });

    it('keeps an earlier deploy-gate rejection over a failing constructor', async function() {
        const { dep } = await deployAndRead(NO_META_FAILING);
        assert.strictEqual(dep.initResult.success, false);
        assert.deepStrictEqual(dep.deployGate, { valid: false, error: META_VERDICTS.REQUIRED });
    });

    it('runs no constructor for a contract without initialize, params or not', async function() {
        for (const opts of [{}, { constructorParams: [] }]) {
            const { dep, read } = await deployAndRead(NO_INIT, {}, opts);
            assert.strictEqual(dep.initResult, null, JSON.stringify(opts));
            assert.strictEqual(read, 'unset');
            assert.deepStrictEqual(dep.deployGate, { valid: true });
        }
    });

    it('keeps the legacy params-only trigger on mainnet below the flag-day', async function() {
        const below = await deployAndRead(ZERO_ARG, { network: 'mainnet', block: { timestamp: STRICT_AT - 1 } });
        assert.strictEqual(below.dep.initResult, null);
        assert.strictEqual(below.read, 'unset');
        const at = await deployAndRead(ZERO_ARG, { network: 'mainnet', block: { timestamp: STRICT_AT } });
        assert.strictEqual(at.dep.initResult.success, true, at.dep.initResult.error);
        assert.strictEqual(at.read, 'init');
    });

    it('resolves DEPLOY_INIT_STRICT per network, unknown networks like mainnet', function() {
        assert.strictEqual(gate.isDeployInitStrictActive('mainnet', STRICT_AT - 1), false);
        assert.strictEqual(gate.isDeployInitStrictActive('mainnet', STRICT_AT), true);
        assert.strictEqual(gate.isDeployInitStrictActive('testnet', 0), true);
        assert.strictEqual(gate.isDeployInitStrictActive('regtest', 0), true);
        assert.strictEqual(gate.isDeployInitStrictActive('signet', STRICT_AT - 1), false);
    });
});
