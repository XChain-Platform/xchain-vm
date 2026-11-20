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

const RETRY_XCALL = `
module.exports = { callback: function(xchain) {
    xchain.emit.crossExecute({ targetChain: 'DOGE', contractIndex: 1, method: 'm',
        gasLimit: 5000, callbackMethod: 'callback' });
    return String(xchain.getCrossHops());
}, hops: function(xchain) { return String(xchain.getCrossHops()); } };`;

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: XCALL callback mode', function() {
    this.timeout(30000);

    it('uses the callback ceiling and threads the originating hop count', async function() {
        const sim = new ContractSimulator();
        try {
            const dep = await sim.deploy(RETRY_XCALL);
            const plain = await sim.call(dep.contractIndex, 'callback', [], { callback: true });
            assert.strictEqual(plain.success, true, plain.error);

            const pinned = await sim.callXcallCallback(dep.contractIndex, 'callback', [], { crossHops: 0 });
            assert.strictEqual(pinned.success, false, 'the 27500 minimum charge must not fit the 20000 callback ceiling');
            assert.match(String(pinned.error), /exceeds remaining gas/);
            assert.ok(pinned.gasUsed <= 20000, 'settled gas must stay inside the callback ceiling');

            const roomy = await sim.callXcallCallback(dep.contractIndex, 'callback', [], {
                gasLimit: 50000,
                crossHops: 0
            });
            assert.strictEqual(roomy.success, true, roomy.error);

            const hops = await sim.callXcallCallback(dep.contractIndex, 'hops', [], { crossHops: 2 });
            assert.strictEqual(hops.success, true, hops.error);
            assert.strictEqual(JSON.parse(hops.returnValue), '2');
        } finally { await sim.close(); }
    });

    it('rejects an invalid VM_XCALL_CALLBACK schedule value', async function() {
        const sim = new ContractSimulator({ gasSchedule: { VM_XCALL_CALLBACK: 0 } });
        try {
            const dep = await sim.deploy('module.exports = { callback: function(){ return "ok"; } };');
            await assert.rejects(
                sim.callXcallCallback(dep.contractIndex, 'callback'),
                /VM_XCALL_CALLBACK missing or invalid/
            );
        } finally { await sim.close(); }
    });

    it('warns once when bare callback mode has no explicit gas limit', async function() {
        const sim = new ContractSimulator();
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (message) => warnings.push(String(message));
        try {
            const dep = await sim.deploy('module.exports = { callback: function(){ return "ok"; } };');
            await sim.call(dep.contractIndex, 'callback', [], { callback: true });
            await sim.call(dep.contractIndex, 'callback', [], { callback: true });
            await sim.call(dep.contractIndex, 'callback', [], { callback: true, gasLimit: 20000 });
            assert.strictEqual(warnings.filter(message => message.includes('callXcallCallback')).length, 1);
        } finally {
            console.warn = originalWarn;
            await sim.close();
        }
    });
});
