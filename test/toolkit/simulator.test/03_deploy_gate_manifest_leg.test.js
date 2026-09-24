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
 * Toolkit: the third leg of the simulator's DEPLOY gate (manifest read,
 * policy rows, CONTRACT_META_REQUIRED ladder). Needs the isolated-vm
 * binding, so the require is guarded and the suite SKIPS where it cannot
 * dlopen. Runs for real on Node 22 / Linux (CI).
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

const META = 'meta: { name: "Probe", description: "A probe contract" }, ';
const withBody = (exportsBody) => 'module.exports = { ' + exportsBody + 'run: function(){ return "ok"; } };';

// Deploys src on a fresh simulator, with warnings silenced, and returns the verdict.
async function verdictOf(src, opts) {
    const sim = new ContractSimulator(opts);
    const real = console.warn;
    console.warn = () => {};
    try { return (await sim.deploy(src)).deployGate; } finally { console.warn = real; await sim.close(); }
}

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: deploy gate manifest leg', function() {
    this.timeout(30000);

    it('rejects a contract with no meta on the default regtest network, and still registers it', async function() {
        const sim = new ContractSimulator();
        const lines = [];
        const real = console.warn;
        console.warn = (...a) => lines.push(a.join(' '));
        try {
            const dep = await sim.deploy(withBody(''));
            assert.deepStrictEqual(dep.deployGate, { valid: false, error: META_VERDICTS.REQUIRED });
            const res = await sim.call(dep.contractIndex, 'run', []);
            assert.strictEqual(res.success, true, res.error);
            assert.ok(lines.some((l) => l.includes('records `' + META_VERDICTS.REQUIRED + '`')),
                JSON.stringify(lines));
        } finally { console.warn = real; await sim.close(); }
    });

    it('accepts a conforming literal meta and a meta computed at module load', async function() {
        assert.deepStrictEqual(await verdictOf(withBody(META)), { valid: true });
        const computed = 'var n = ["Pro", "be"].join(""); module.exports = { meta: { name: n, ' +
            'description: "Built at load" }, run: function(){ return "ok"; } };';
        assert.deepStrictEqual(await verdictOf(computed), { valid: true });
    });

    it('rejects a module top level that throws as a failed manifest read', async function() {
        const src = 'throw new Error("boom"); module.exports = { ' + META + 'run: function(){ return 1; } };';
        assert.deepStrictEqual(await verdictOf(src), { valid: false, error: META_VERDICTS.READ_FAILED });
    });

    it('rejects meta rows in ladder order with the chain strings', async function() {
        const cases = [
            ['meta: "Probe", ', META_VERDICTS.NOT_OBJECT],
            ['meta: { name: " Probe", description: "d" }, ', META_VERDICTS.NAME],
            ['meta: { name: "Probe", description: "" }, ', META_VERDICTS.DESCRIPTION],
            ['meta: { name: "Probe", description: "d", version: 3 }, ', META_VERDICTS.VERSION]
        ];
        for (const [body, error] of cases) {
            assert.deepStrictEqual(await verdictOf(withBody(body)), { valid: false, error }, body);
        }
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: deploy gate manifest leg', function() {
    this.timeout(30000);

    it('rejects malformed permissions and maxTakeBps ahead of the meta rows', async function() {
        const P = gate.MANIFEST_POLICY_VERDICTS;
        const cases = [
            ['permissions: "SEND", ', P.PERMISSIONS_ARRAY],
            ['permissions: [1], ', P.PERMISSIONS_STRINGS],
            ['maxTakeBps: 20000, ', P.MAX_TAKE_BPS],
            ['maxTakeBps: 1.5, ', P.MAX_TAKE_BPS]
        ];
        for (const [body, error] of cases) {
            // No meta either: the policy row wins, as it does on chain.
            assert.deepStrictEqual(await verdictOf(withBody(body)), { valid: false, error }, body);
        }
        assert.deepStrictEqual(
            await verdictOf(withBody(META + 'permissions: ["SEND"], maxTakeBps: 500, ')), { valid: true });
    });

    it('arms the meta rule on testnet at its flag time and keeps the policy rows ungated', async function() {
        const at = 1789257600;
        const before = { network: 'testnet', block: { timestamp: at - 1 } };
        assert.deepStrictEqual(await verdictOf(withBody(''), before), { valid: true });
        assert.deepStrictEqual(await verdictOf(withBody(''), { network: 'testnet', block: { timestamp: at } }),
            { valid: false, error: META_VERDICTS.REQUIRED });
        assert.deepStrictEqual(await verdictOf(withBody('maxTakeBps: -1, '), before),
            { valid: false, error: gate.MANIFEST_POLICY_VERDICTS.MAX_TAKE_BPS });
    });

    it('resolves the activation per network, unknown networks like mainnet', function() {
        assert.strictEqual(gate.isContractMetaRequiredActive('mainnet', 0), true);
        assert.strictEqual(gate.isContractMetaRequiredActive('regtest', 0), true);
        assert.strictEqual(gate.isContractMetaRequiredActive('testnet', 1789257599), false);
        assert.strictEqual(gate.isContractMetaRequiredActive('testnet', 1789257600), true);
        assert.strictEqual(gate.isContractMetaRequiredActive('signet', 0), true);
    });
});
