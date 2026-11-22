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
 * Toolkit simulator parity for per-provider attestation deadline windows.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const META = 'meta: { name: "Deadline probe", description: "Checks provider deadline windows" }, ';
const CALLS = 'module.exports = { ' + META +
    'over: function(xchain){ return xchain.attestation.request("llm", "p", "cb", [], ' +
        '{ redundancy: 1, deadlineBlocks: 50 }); }, ' +
    'at: function(xchain){ return xchain.attestation.request("llm", "p", "cb", [], ' +
        '{ redundancy: 1, deadlineBlocks: 20 }); }, ' +
    'wide: function(xchain){ return xchain.attestation.request("http_get", "u", "cb", [], ' +
        '{ redundancy: 1, deadlineBlocks: 100 }); } };';
const CONSTRUCTOR = 'module.exports = { ' + META +
    'initialize: function(xchain){ return xchain.attestation.request("llm", "p", "cb", [], ' +
        '{ redundancy: 1, deadlineBlocks: 50 }); } };';

async function withSimulator(opts, run) {
    const sim = new ContractSimulator(opts);
    try { return await run(sim); } finally { await sim.close(); }
}

function registerDefaultCases() {
    it('enforces the registry windows by default', async function() {
        await withSimulator({}, async (sim) => {
            const dep = await sim.deploy(CALLS);
            const over = await sim.call(dep.contractIndex, 'over');
            assert.strictEqual(over.success, false);
            assert.match(over.error || '', /exceeds the "llm" provider window of 20 blocks/);
            const at = await sim.call(dep.contractIndex, 'at');
            assert.strictEqual(at.success, true, at.error);
            const wide = await sim.call(dep.contractIndex, 'wide');
            assert.strictEqual(wide.success, true, wide.error);
        });
    });

    it('applies the default window to a deploy constructor', async function() {
        await withSimulator({}, async (sim) => {
            const dep = await sim.deploy(CONSTRUCTOR);
            assert.strictEqual(dep.initResult.success, false);
            assert.match(dep.initResult.error || '', /exceeds the "llm" provider window of 20 blocks/);
            assert.strictEqual(dep.deployGate.valid, false);
        });
    });
}

function registerOverrideCases() {
    it('allows an explicit null constructor opt-out', async function() {
        await withSimulator({ providerDeadlines: null }, async (sim) => {
            const dep = await sim.deploy(CALLS);
            const result = await sim.call(dep.contractIndex, 'over');
            assert.strictEqual(result.success, true, result.error);
        });
    });

    it('allows a per-call window override', async function() {
        await withSimulator({}, async (sim) => {
            const dep = await sim.deploy(CALLS);
            const result = await sim.call(dep.contractIndex, 'over', [], {
                providerDeadlines: { llm: 60 }
            });
            assert.strictEqual(result.success, true, result.error);
        });
    });
}

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: provider deadlines', function() {
    this.timeout(30000);
    registerDefaultCases();
    registerOverrideCases();
});
