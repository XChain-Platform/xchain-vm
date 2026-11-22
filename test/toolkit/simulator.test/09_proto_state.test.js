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
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const STATE_CONTRACT = `
module.exports = {
    put: function(xchain) {
        xchain.state.set('__proto__', xchain.getInputParam(0));
        xchain.state.set('count', '1');
        return 'saved';
    },
    peek: function(xchain) { return xchain.state.get('__proto__'); }
};`;

(ContractSimulator ? describe : describe.skip)('Toolkit simulator prototype-named state', function() {
    this.timeout(30000);

    it('persists, snapshots, and seeds __proto__ as an ordinary state key', async function() {
        const sim = new ContractSimulator();
        try {
            const deployed = await sim.deploy(STATE_CONTRACT);
            const written = await sim.call(deployed.contractIndex, 'put', ['saved']);
            assert.strictEqual(written.success, true);
            const read = await sim.call(deployed.contractIndex, 'peek', []);
            assert.strictEqual(JSON.parse(read.returnValue), 'saved');
            assert.strictEqual(sim.getStateValue(deployed.contractIndex, '__proto__'), 'saved');
            assert.strictEqual(sim.getStateValue(deployed.contractIndex, 'count'), '1');
            const snapshot = sim.getState(deployed.contractIndex);
            assert.strictEqual(Object.getPrototypeOf(snapshot), null);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(snapshot, '__proto__'), true);
            assert.strictEqual(snapshot.__proto__, 'saved');

            const seeded = await sim.deploy(STATE_CONTRACT, {
                state: JSON.parse('{"__proto__":"seeded","count":"2"}'),
            });
            const seededRead = await sim.call(seeded.contractIndex, 'peek', []);
            assert.strictEqual(JSON.parse(seededRead.returnValue), 'seeded');
            assert.strictEqual(sim.getState(seeded.contractIndex).count, '2');
        } finally {
            await sim.close();
        }
    });
});
