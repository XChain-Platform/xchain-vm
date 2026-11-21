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
 * Toolkit: cross-chain seeding after the first execute of a block must be
 * visible in subprocess mode exactly as it is in-process. The subprocess
 * executor pins the crossChainData object it sees first in a block and sends
 * later executes a token for that copy unless the object it is handed is a
 * different, non-equal one, so a setter that writes into the pinned object in
 * place leaves every later read on the stale copy.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const READER = `
module.exports = { default: function(xchain) {
    var r = xchain.crossChain.getCallResult('AABB');
    return JSON.stringify({
        att:     xchain.crossChain.getAttestation('DOGE', '9'),
        settled: xchain.crossChain.isSettled('DOGE', '9'),
        status:  r ? r.status : null
    });
} };`;

async function read(sim, index) {
    const r = await sim.call(index, 'default', []);
    assert.strictEqual(r.success, true, r.error);
    return JSON.parse(JSON.parse(r.returnValue));
}

// Read before seeding, seed, read, reseed, read: all inside one block.
async function seededSequence(sim) {
    const dep = await sim.deploy(READER);
    const reads = [await read(sim, dep.contractIndex)];
    sim.setCrossChainAttestation('DOGE', '9', 'proof')
       .setCrossChainSettled('DOGE', '9')
       .setCallResult('AABB', { status: 'success', payload: 'ok' });
    reads.push(await read(sim, dep.contractIndex));
    sim.setCrossChainAttestation('DOGE', '9', 'proof2');
    reads.push(await read(sim, dep.contractIndex));
    return reads;
}

const EXPECTED = [
    { att: null, settled: false, status: null },
    { att: 'proof', settled: true, status: 'success' },
    { att: 'proof2', settled: true, status: 'success' }
];

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: subprocess cross-chain seeding', function() {
    this.timeout(60000);

    it('a seed made after deploy is readable in subprocess mode', async function() {
        const sim = new ContractSimulator({ execution: 'subprocess' });
        try {
            const dep = await sim.deploy(READER);
            sim.setCrossChainAttestation('DOGE', '9', 'proof')
               .setCrossChainSettled('DOGE', '9')
               .setCallResult('AABB', { status: 'success', payload: 'ok' });
            assert.deepStrictEqual(await read(sim, dep.contractIndex),
                { att: 'proof', settled: true, status: 'success' });
        } finally { await sim.close(); }
    });

    it('repeated mid-block seeding is seen by every later subprocess call', async function() {
        const sim = new ContractSimulator({ execution: 'subprocess' });
        try {
            assert.deepStrictEqual(await seededSequence(sim), EXPECTED);
        } finally { await sim.close(); }
    });

    it('subprocess reads match in-process reads for the same seeding sequence', async function() {
        const inProc = new ContractSimulator();
        const sub = new ContractSimulator({ execution: 'subprocess' });
        try {
            const a = await seededSequence(inProc);
            const b = await seededSequence(sub);
            assert.deepStrictEqual(b, a);
        } finally {
            await inProc.close();
            await sub.close();
        }
    });

    it('a setter never writes into the snapshot object an earlier call was handed', async function() {
        const sim = new ContractSimulator({ execution: 'subprocess' });
        try {
            const dep = await sim.deploy(READER);
            await read(sim, dep.contractIndex);
            const before = sim.crossChainData;
            sim.setCrossChainAttestation('DOGE', '9', 'proof')
               .setCrossChainSettled('DOGE', '9')
               .setCallResult('AABB', { status: 'success', payload: 'ok' });
            assert.notStrictEqual(sim.crossChainData, before);
            assert.deepStrictEqual(before, { attestations: {}, settled: {}, calls: {} });
        } finally { await sim.close(); }
    });
});
