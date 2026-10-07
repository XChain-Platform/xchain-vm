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
 * Native iteration, string and Set algebra metering gate.
 *
 * Iterator helpers (toArray, drop), String isWellFormed/toWellFormed, the Set
 * algebra family do O(n) native work that the AST meter bills at a flat unit per
 * call. The metering is gated: regtest runs it
 * from genesis, mainnet and testnet are unarmed (null). The same gate fails a run
 * whose gas-exhaustion fault was swallowed by an Object.* statics wrapper.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

const K = 100000;
const WALL_MS = 30000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

const ARR = `var a=new Array(${K}).fill(7);`;
const VECTORS = {
    'Iterator toArray': `${ARR}var t=0;for(;;){t+=a.values().toArray().length;}`,
    'Iterator drop': `${ARR}var t=0;for(;;){t+=a.values().drop(${K}-1).next().value;}`,
    'String isWellFormed': `var s=String.fromCharCode(0x100).repeat(${K});var t=0;for(;;){if(s.isWellFormed())t++;}`,
    'String toWellFormed': `var s=String.fromCharCode(0xD800).repeat(${K});var t=0;for(;;){t+=s.toWellFormed().length;}`,
    'Call spread': `${ARR}function f(){return arguments.length;}var t=0;for(;;){t+=f(...a);}`,
    'Set union': `var x=new Set(),y=new Set();for(var j=0;j<${K};j++){x.add(j);y.add(j+${K});}var t=0;for(;;){t+=x.union(y).size;}`,
};
const SET_METHODS = ['union', 'intersection', 'difference', 'symmetricDifference',
    'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'];

(XChainVM ? describe : describe.skip)('iterator, string and Set algebra metering gate', function () {
    this.timeout(120000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: WALL_MS }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const on = (code, extra) => execute(vm, wrap(code), { method: 'default', network: 'regtest', blockContext: LATE, ...extra });
    const off = (code, extra) => execute(vm, wrap(code), { method: 'default', network: 'mainnet', blockContext: LATE, ...extra });

    for (const id of Object.keys(VECTORS)) {
        it(`${id}: a hostile loop ends in out_of_gas well under the wall`, async function () {
            const t0 = Date.now();
            const r = await on(VECTORS[id]);
            const wall = Date.now() - t0;
            assert.strictEqual(r.success, false, id);
            assert.match(r.error, /^out_of_gas:/, `${id}: ${r.error}`);
            assert.ok(wall < WALL_MS, `${id}: ${wall} ms`);
        });
    }

    it('each Set algebra method is charged by operand size', async function () {
        const setup = `var x=new Set(),y=new Set();for(var j=0;j<2000;j++){x.add(j);y.add(j+1000);}`;
        for (const m of SET_METHODS) {
            const body = `${setup}x.${m}(y);return 1;`;
            const armed = await on(body);
            const unarmed = await off(body);
            assert.strictEqual(armed.success, true, `${m}: ${armed.error}`);
            assert.ok(armed.gasUsed >= unarmed.gasUsed + 4000, `${m}: ${armed.gasUsed} vs ${unarmed.gasUsed}`);
        }
    });

    it('Iterator toArray and drop plus isWellFormed/toWellFormed are charged by size', async function () {
        const bodies = {
            toArray: `${ARR}a.values().toArray();return 1;`,
            drop: `${ARR}a.values().drop(${K - 1}).next();return 1;`,
            isWellFormed: `var s='x'.repeat(${K});s.isWellFormed();return 1;`,
            toWellFormed: `var s='x'.repeat(${K});s.toWellFormed();return 1;`,
        };
        for (const id of Object.keys(bodies)) {
            const armed = await on(bodies[id], { gasCeiling: undefined });
            const unarmed = await off(bodies[id]);
            assert.strictEqual(armed.success, true, `${id}: ${armed.error}`);
            assert.ok(armed.gasUsed >= unarmed.gasUsed + K - 10, `${id}: ${armed.gasUsed} vs ${unarmed.gasUsed}`);
        }
    });

    it('mainnet, testnet and unknown networks are unarmed: a single call costs the legacy flat charge', async function () {
        const body = `${ARR}a.values().toArray();return 1;`;
        const armed = await on(body);
        const gas = {};
        for (const network of ['mainnet', 'testnet', undefined, 'unknown']) {
            const r = await execute(vm, wrap(body), { method: 'default', network, blockContext: LATE });
            gas[String(network)] = r.gasUsed;
            assert.ok(armed.gasUsed >= r.gasUsed + K - 10, String(network));
        }
        assert.strictEqual(gas.mainnet, gas.testnet);
        assert.strictEqual(gas.undefined, gas.unknown);
    });

    it('a swallowed Object.keys gas exhaustion fails the run once active', async function () {
        const small = createVM({ gasCeiling: 5000, maxCpuTimeMs: WALL_MS });
        small.beginBlock();
        try {
            const body = `var a=new Array(3000).fill(1);Object.keys(a);return 5;`;
            const armed = await execute(small, wrap(body), { method: 'default', network: 'regtest', blockContext: LATE });
            assert.strictEqual(armed.success, false);
            assert.match(armed.error, /^out_of_gas:/, armed.error);
            assert.strictEqual(armed.gasUsed, 5000);
            const legacy = await execute(small, wrap(body), { method: 'default', network: 'mainnet', blockContext: LATE });
            assert.strictEqual(legacy.success, true, 'pre-activation replay keeps the swallowed fault');
            assert.ok(legacy.gasUsed > 5000, 'the legacy run completed past its ceiling');
        } finally {
            if (small.endBlock) small.endBlock();
        }
    });
});
