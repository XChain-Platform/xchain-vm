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
 * Toolkit: ContractSimulator read-surface scope. Needs the isolated-vm
 * binding, so the require is guarded and the suite SKIPS where it cannot
 * dlopen. Runs for real on Node 22 / Linux (CI).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

// Reads the round named by param 0 and classifies the answer the way a price-bet settle branch does.
const ROUND_READER =
    'module.exports = function(xchain){ var r = xchain.oracle.getPriceAtRound("BTC/USD", ' +
    'Number(xchain.getInputParam(0))); return r ? (r.outsideWindow === true ? "outside" : "row") : "null"; };';

const BALANCE_READER =
    'module.exports = function(xchain){ return xchain.getBalance(xchain.getInputParam(0), "GOLD"); };';

// Captures console.warn lines for the duration of fn, restoring it even on a throw.
async function captureWarnings(fn) {
    const lines = [];
    const real = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.warn = real; }
    return lines;
}

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: oracle round floor', function() {
    this.timeout(30000);

    it('carries roundFloor 0 by default, so a missing old round reads plain null', async function() {
        const sim = new ContractSimulator();
        sim.setPrice('BTC/USD', { price: '65000', roundNumber: 100 });
        try {
            assert.strictEqual(sim.oracle.roundFloor, 0);
            const dep = await sim.deploy(ROUND_READER);
            const res = await sim.call(dep.contractIndex, 'default', ['10']);
            assert.strictEqual(JSON.parse(res.returnValue), 'null', res.error);
        } finally { await sim.close(); }
    });

    it('answers outsideWindow below a floor set with setOracleRoundFloor', async function() {
        const sim = new ContractSimulator();
        sim.setPrice('BTC/USD', { price: '65000', roundNumber: 100 }).setOracleRoundFloor(50);
        try {
            const dep = await sim.deploy(ROUND_READER);
            const below = await sim.call(dep.contractIndex, 'default', ['10']);
            assert.strictEqual(JSON.parse(below.returnValue), 'outside', below.error);
            const seeded = await sim.call(dep.contractIndex, 'default', ['100']);
            assert.strictEqual(JSON.parse(seeded.returnValue), 'row', seeded.error);
            const aboveFloor = await sim.call(dep.contractIndex, 'default', ['60']);
            assert.strictEqual(JSON.parse(aboveFloor.returnValue), 'null', aboveFloor.error);
        } finally { await sim.close(); }
    });

    it('normalizes a non-positive or non-numeric floor to 0', async function() {
        const sim = new ContractSimulator();
        try {
            assert.strictEqual(sim.setOracleRoundFloor(-5).oracle.roundFloor, 0);
            assert.strictEqual(sim.setOracleRoundFloor('x').oracle.roundFloor, 0);
            assert.strictEqual(sim.setOracleRoundFloor('7').oracle.roundFloor, 7);
        } finally { await sim.close(); }
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: balance snapshot scope', function() {
    this.timeout(30000);

    it('warns once, naming the address, when a balance is seeded outside caller + contract', async function() {
        const sim = new ContractSimulator({ coin: 'BTC' });
        sim.setBalance('alice', 'GOLD', '1000');
        let first = null;
        const lines = await captureWarnings(async () => {
            try {
                const dep = await sim.deploy(BALANCE_READER);
                first = await sim.call(dep.contractIndex, 'default', ['alice']);
                await sim.call(dep.contractIndex, 'default', ['alice']);
            } finally { await sim.close(); }
        });
        // Advisory only: the seed still reads back here.
        assert.strictEqual(JSON.parse(first.returnValue), '1000', first.error);
        const scope = lines.filter((l) => /outside this call's snapshot scope/.test(l));
        assert.strictEqual(scope.length, 1, JSON.stringify(lines));
        assert.match(scope[0], /"alice"/);
        assert.match(scope[0], /"sim_caller"/);
    });

    it('stays silent when only the caller and the contract address are seeded', async function() {
        const sim = new ContractSimulator({ coin: 'BTC', defaultCaller: 'alice' });
        sim.setBalance('alice', 'GOLD', '1000').setBalance('C:BTC:0', 'GOLD', '5');
        const lines = await captureWarnings(async () => {
            try {
                const dep = await sim.deploy(BALANCE_READER);
                assert.strictEqual(dep.contractAddress, 'C:BTC:0');
                await sim.call(dep.contractIndex, 'default', ['C:BTC:0']);
            } finally { await sim.close(); }
        });
        const scope = lines.filter((l) => /outside this call's snapshot scope/.test(l));
        assert.deepStrictEqual(scope, []);
    });
});
