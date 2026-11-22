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

'use strict';

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const SWALLOWED = `
module.exports = {
    meta: { name: 'Gas cap probe', description: 'Catches a gas exhaustion fault' },
    default: function(xchain) {
        var a = new Array(3000).fill(1);
        Object.keys(a);
        return 5;
    }
};`;

const SMALL = `
module.exports = {
    meta: { name: 'Small call', description: 'Stays below the gas ceiling' },
    default: function() { return 7; }
};`;

async function deployAndCall(sim, code, opts) {
    const dep = await sim.deploy(code);
    return sim.call(dep.contractIndex, 'default', [], opts);
}

(ContractSimulator ? describe : describe.skip)('Toolkit simulator gas settlement cap', function() {
    this.timeout(30000);

    it('caps a mainnet swallowed-exhaustion success and preserves the raw value', async function() {
        const sim = new ContractSimulator({ network: 'mainnet', gasCeiling: 5000 });
        try {
            const result = await deployAndCall(sim, SWALLOWED);
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(result.gasUsed, 5000);
            assert.ok(result.gasUsedRaw > result.gasUsed);
        } finally { await sim.close(); }
    });

    it('uses the effective requested ceiling and ignores invalid limits', async function() {
        const sim = new ContractSimulator({ network: 'mainnet' });
        const invalidSim = new ContractSimulator({ network: 'mainnet', gasCeiling: 5000 });
        try {
            const requested = await deployAndCall(sim, SWALLOWED, { gasLimit: 5000 });
            assert.strictEqual(requested.success, true, requested.error);
            assert.strictEqual(requested.gasUsed, 5000);
            assert.ok(requested.gasUsedRaw > requested.gasUsed);

            const invalid = await deployAndCall(invalidSim, SWALLOWED, { gasLimit: 0 });
            assert.strictEqual(invalid.success, true, invalid.error);
            assert.strictEqual(invalid.gasUsed, 5000);
            assert.ok(invalid.gasUsedRaw > invalid.gasUsed);
        } finally { await sim.close(); await invalidSim.close(); }
    });

    it('leaves already-bounded results unchanged', async function() {
        const sim = new ContractSimulator({ network: 'mainnet', gasCeiling: 5000 });
        try {
            const result = await deployAndCall(sim, SMALL);
            assert.strictEqual(result.success, true, result.error);
            assert.ok(result.gasUsed < 5000);
            assert.strictEqual(Object.hasOwn(result, 'gasUsedRaw'), false);
        } finally { await sim.close(); }
    });

    it('does not add a raw field when an armed network returns out_of_gas', async function() {
        const sim = new ContractSimulator({ network: 'regtest', gasCeiling: 5000 });
        try {
            const result = await deployAndCall(sim, SWALLOWED);
            assert.strictEqual(result.success, false);
            assert.match(result.error, /^out_of_gas:/);
            assert.strictEqual(result.gasUsed, 5000);
            assert.strictEqual(Object.hasOwn(result, 'gasUsedRaw'), false);
        } finally { await sim.close(); }
    });

});
