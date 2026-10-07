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
 * Function.prototype.apply argument-length metering gate.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const runtime = require('../../src/index.js');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

const K = 100000;
const WALL_MS = 30000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const ARR = `var a=new Array(${K}).fill(7);`;
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

function registerGateIsolationTest(run) {
    it('disarming apply does not disarm iterator metering', async function () {
        const activation = runtime.APPLY_LENGTH_METER_ACTIVATION;
        const saved = activation.regtest;
        activation.regtest = null;
        try {
            const applyBody = `${ARR}Math.max.apply(null,a);return 1;`;
            const iterBody = `${ARR}a.values().toArray();return 1;`;
            const applyRegtest = await run(applyBody, 'regtest');
            const applyMainnet = await run(applyBody, 'mainnet');
            const iterRegtest = await run(iterBody, 'regtest', { gasCeiling: undefined });
            const iterMainnet = await run(iterBody, 'mainnet');
            assert.strictEqual(applyRegtest.gasUsed, applyMainnet.gasUsed,
                'apply must follow its own disabled gate');
            assert.ok(iterRegtest.gasUsed >= iterMainnet.gasUsed + K - 10,
                'iterator metering must remain controlled by ITER_SET_METER');
        } finally {
            activation.regtest = saved;
        }
    });
}

(XChainVM ? describe : describe.skip)('Function.prototype.apply length metering gate', function () {
    this.timeout(120000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: WALL_MS }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, network, extra) => execute(vm, wrap(body), {
        method: 'default', network, blockContext: LATE, ...extra,
    });

    for (const [id, call] of [
        ['Function apply', 'f.apply(null,a)'],
        ['Math.max apply', 'Math.max.apply(null,a)'],
    ]) {
        it(`${id}: a hostile loop ends in out_of_gas well under the wall`, async function () {
            const setup = id === 'Function apply' ? `${ARR}function f(){return arguments.length;}` : ARR;
            const t0 = Date.now();
            const r = await run(`${setup}var t=0;for(;;){t+=${call};}`, 'regtest');
            assert.strictEqual(r.success, false, id);
            assert.match(r.error, /^out_of_gas:/, `${id}: ${r.error}`);
            assert.ok(Date.now() - t0 < WALL_MS, id);
        });
    }

    it('apply is charged by argument-list length only on an armed network', async function () {
        const body = `${ARR}Math.max.apply(null,a);return 1;`;
        const armed = await run(body, 'regtest', { gasCeiling: undefined });
        const unarmed = await run(body, 'mainnet');
        assert.strictEqual(armed.success, true, armed.error);
        assert.ok(armed.gasUsed >= unarmed.gasUsed + K - 10,
            `${armed.gasUsed} vs ${unarmed.gasUsed}`);
    });

    it('mainnet, testnet and unknown networks retain the legacy flat charge', async function () {
        const body = `${ARR}Math.max.apply(null,a);return 1;`;
        const gas = {};
        for (const network of ['mainnet', 'testnet', undefined, 'unknown']) {
            const r = await run(body, network);
            assert.strictEqual(r.success, true, `${network}: ${r.error}`);
            gas[String(network)] = r.gasUsed;
        }
        assert.strictEqual(gas.mainnet, gas.testnet);
        assert.strictEqual(gas.undefined, gas.unknown);
    });

    registerGateIsolationTest(run);
});
