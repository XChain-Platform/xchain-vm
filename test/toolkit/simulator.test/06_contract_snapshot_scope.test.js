/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Toolkit: contract-scoped stake and attestation snapshots. Needs the
 * isolated-vm binding, so the require is guarded and the suite SKIPS where
 * it cannot dlopen. Runs for real on Node 22 / Linux.
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
const STAKE_READER = `
module.exports = { default: function(xchain) {
    return JSON.stringify({
        stake: xchain.contract.getStake('${PK('a')}', 'GOLD'),
        total: xchain.contract.getTotalStaked('GOLD'),
        stakers: xchain.contract.getStakers('GOLD').length
    });
} };`;
const ATTEST_READER = `
module.exports = { default: function(xchain) {
    return xchain.attestation.getResponse('req-1');
} };`;
const CONSTRUCTOR_READER = `
module.exports = {
    meta: { name: 'Snapshot probe', description: 'Checks constructor read scope' },
    initialize: function(xchain) {
        return JSON.stringify({
            response: xchain.attestation.getResponse('req-1'),
            stake: xchain.contract.getStake('${PK('a')}', 'GOLD')
        });
    },
    read: function(xchain) {
        return JSON.stringify({
            response: xchain.attestation.getResponse('req-1'),
            stake: xchain.contract.getStake('${PK('a')}', 'GOLD')
        });
    }
};`;

const jsonResult = (result) => JSON.parse(JSON.parse(result.returnValue));

async function captureWarnings(fn) {
    const lines = [];
    const real = console.warn;
    console.warn = (...args) => lines.push(args.join(' '));
    try { await fn(); } finally { console.warn = real; }
    return lines;
}

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: contract snapshot scope', function() {
    this.timeout(30000);

    it('limits a scoped stake snapshot to its target contract', async function() {
        const sim = new ContractSimulator();
        try {
            const a = await sim.deploy(STAKE_READER);
            const b = await sim.deploy(STAKE_READER);
            sim.setStake(PK('a'), 'GOLD', '400', a.contractIndex);
            const fromA = jsonResult(await sim.call(a.contractIndex));
            const fromB = jsonResult(await sim.call(b.contractIndex));
            assert.deepStrictEqual(fromA, { stake: '400', total: '400', stakers: 1 });
            assert.deepStrictEqual(fromB, { stake: '0', total: '0', stakers: 0 });
        } finally { await sim.close(); }
    });

    it('limits a scoped attestation response to its target contract', async function() {
        const sim = new ContractSimulator();
        try {
            const a = await sim.deploy(ATTEST_READER);
            const b = await sim.deploy(ATTEST_READER);
            sim.setAttestationResponse('req-1', 'answer', a.contractIndex);
            assert.strictEqual(JSON.parse((await sim.call(a.contractIndex)).returnValue), 'answer');
            assert.strictEqual(JSON.parse((await sim.call(b.contractIndex)).returnValue), null);
        } finally { await sim.close(); }
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: contract snapshot scope', function() {
    this.timeout(30000);

    it('keeps unscoped seeds compatible and warns once with multiple contracts', async function() {
        const sim = new ContractSimulator();
        let fromA;
        let fromB;
        const lines = await captureWarnings(async () => {
            try {
                const a = await sim.deploy(STAKE_READER);
                const b = await sim.deploy(STAKE_READER);
                sim.setStake(PK('a'), 'GOLD', '400');
                fromA = jsonResult(await sim.call(a.contractIndex));
                fromB = jsonResult(await sim.call(b.contractIndex));
                await sim.call(a.contractIndex);
            } finally { await sim.close(); }
        });
        assert.strictEqual(fromA.stake, '400');
        assert.strictEqual(fromB.stake, '400');
        const scope = lines.filter((line) => line.includes('without a contractIndex'));
        assert.strictEqual(scope.length, 1, JSON.stringify(lines));
    });

    it('does not warn about an unscoped seed with one contract', async function() {
        const sim = new ContractSimulator();
        const lines = await captureWarnings(async () => {
            try {
                const dep = await sim.deploy(STAKE_READER);
                sim.setStake(PK('a'), 'GOLD', '400');
                await sim.call(dep.contractIndex);
            } finally { await sim.close(); }
        });
        assert.deepStrictEqual(lines.filter((line) => line.includes('without a contractIndex')), []);
    });

    it('keeps exact stake arithmetic inside a scoped bucket', async function() {
        const sim = new ContractSimulator();
        try {
            sim.setStake(PK('a'), 'GOLD', '0.1', 0).setStake(PK('b'), 'GOLD', '0.2', 0);
            assert.strictEqual(sim.contractStakeDataByIndex.get(0).totalByTick.GOLD, '0.3');
        } finally { await sim.close(); }
    });

    it('gives initialize no stake or attestation snapshot', async function() {
        const sim = new ContractSimulator();
        try {
            sim.setStake(PK('a'), 'GOLD', '400', 0)
                .setAttestationResponse('req-1', 'answer', 0);
            const dep = await sim.deploy(CONSTRUCTOR_READER);
            assert.deepStrictEqual(jsonResult(dep.initResult), { response: null, stake: '0' });
            const ordinary = await sim.call(dep.contractIndex, 'read');
            assert.deepStrictEqual(jsonResult(ordinary), { response: 'answer', stake: '400' });
        } finally { await sim.close(); }
    });
});
