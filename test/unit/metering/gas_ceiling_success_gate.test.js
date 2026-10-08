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
 * Gas-ceiling success gate.
 *
 * A run whose gas-exhaustion fault was swallowed inside the isolate reaches the
 * host as a success with gasUsed past the ceiling. Once the gate is active the run
 * fails out_of_gas at the ceiling; below it the legacy success replays unchanged.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const GasTracker = require('../../../src/gas.js');
const vmModule = require('../../../src/index.js');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');

const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const { isGasCeilingSuccessActive, GAS_CEILING_SUCCESS_ACTIVATION } = GasTracker;

describe('gas-ceiling success gate resolver', function () {
    it('is armed from genesis on regtest only', function () {
        assert.strictEqual(isGasCeilingSuccessActive('regtest', 0), true);
        assert.strictEqual(isGasCeilingSuccessActive('regtest', undefined), true);
        for (const net of ['mainnet', 'testnet', undefined, null, 'unknown', '__proto__', 'toString']) {
            assert.strictEqual(isGasCeilingSuccessActive(net, 4000000000), false, String(net));
        }
    });

    it('is frozen: regtest from genesis, mainnet and testnet unarmed until a release cut', function () {
        assert.deepStrictEqual({ ...GAS_CEILING_SUCCESS_ACTIVATION }, { mainnet: null, testnet: null, regtest: 0 });
        assert.ok(Object.isFrozen(GAS_CEILING_SUCCESS_ACTIVATION));
    });

    it('is exposed on the entry point statics', function () {
        assert.strictEqual(vmModule.isGasCeilingSuccessActive, isGasCeilingSuccessActive);
        assert.strictEqual(vmModule.GAS_CEILING_SUCCESS_ACTIVATION, GAS_CEILING_SUCCESS_ACTIVATION);
    });
});

describe('gas-ceiling success gate tracker', function () {
    const schedule = Object.fromEntries(GasTracker.CANONICAL_GAS_KEYS.map(k => [k, 1]));

    it('records that a charge crossed the ceiling even when the fault is caught', function () {
        const t = new GasTracker(schedule, 10);
        assert.strictEqual(t.exhausted, false);
        try { t.charge(11); } catch (e) { /* swallowed, as the isolate wrapper does */ }
        assert.strictEqual(t.exhausted, true);
    });
});

describe('gas-ceiling success gate execution', function () {
    this.timeout(60000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 5000, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, network) => execute(vm, wrap(body), { method: 'default', network, blockContext: LATE });
    const SWALLOWED = `var a=new Array(3000).fill(1);Object.keys(a);return 5;`;

    it('fails a swallowed Object.keys exhaustion out_of_gas at the ceiling once armed', async function () {
        const r = await run(SWALLOWED, 'regtest');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, 5000);
    });

    it('replays the legacy success while unarmed', async function () {
        for (const net of ['mainnet', 'testnet', undefined]) {
            const r = await run(SWALLOWED, net);
            assert.strictEqual(r.success, true, String(net));
            assert.ok(r.gasUsed > 5000, String(net));
        }
    });

    it('leaves a run that stays under the ceiling untouched when armed', async function () {
        const r = await run('return 7;', 'regtest');
        assert.strictEqual(r.success, true);
        assert.ok(r.gasUsed < 5000);
    });
});
