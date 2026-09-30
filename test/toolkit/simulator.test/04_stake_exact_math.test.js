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
 * Toolkit: setStake builds the stake views with the indexer snapshot's
 * exact arithmetic (sum, amount-then-pubkey order, 1000-staker cap).
 * Needs the isolated-vm binding, so the require is guarded and the suite
 * SKIPS where it cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const PK = (c) => c.repeat(64);
const order = (sim, tick) => sim.contractStakeData.stakersByTick[tick].map((s) => s.pubkey);

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: exact stake arithmetic', function() {
    this.timeout(30000);

    it('sums stakes exactly, with no float noise', async function() {
        const sim = new ContractSimulator();
        try {
            sim.setStake(PK('a'), 'GOLD', '0.1').setStake(PK('b'), 'GOLD', '0.2');
            assert.strictEqual(sim.contractStakeData.totalByTick.GOLD, '0.3');
        } finally { await sim.close(); }
    });

    it('orders stakers by exact amount below double precision', async function() {
        const sim = new ContractSimulator();
        try {
            sim.setStake(PK('0'), 'WEI', '1').setStake(PK('f'), 'WEI', '1.000000000000000001');
            assert.deepStrictEqual(order(sim, 'WEI'), [PK('f'), PK('0')]);
            sim.setStake(PK('1'), 'BIG', '9007199254740992').setStake(PK('9'), 'BIG', '9007199254740993');
            assert.deepStrictEqual(order(sim, 'BIG'), [PK('9'), PK('1')]);
        } finally { await sim.close(); }
    });

    it('caps getStakers at 1000 while the total counts every staker', async function() {
        const sim = new ContractSimulator();
        try {
            for (let i = 0; i < 1001; i++) sim.setStake(i.toString(16).padStart(64, '0'), 'GOLD', String(2000 - i));
            const roster = sim.contractStakeData.stakersByTick.GOLD;
            assert.strictEqual(roster.length, 1000);
            assert.strictEqual(roster[999].amount, '1001');
            assert.strictEqual(sim.contractStakeData.totalByTick.GOLD, '1501500');
        } finally { await sim.close(); }
    });

    it('replaces a re-seeded stake and drops a zero one from roster and total', async function() {
        const sim = new ContractSimulator();
        try {
            sim.setStake(PK('a'), 'GOLD', '5').setStake(PK('b'), 'GOLD', '7').setStake(PK('a'), 'GOLD', '3');
            assert.strictEqual(sim.contractStakeData.totalByTick.GOLD, '10');
            sim.setStake(PK('b'), 'GOLD', '0');
            assert.deepStrictEqual(order(sim, 'GOLD'), [PK('a')]);
            assert.strictEqual(sim.contractStakeData.totalByTick.GOLD, '3');
        } finally { await sim.close(); }
    });
});
