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
 * Toolkit: the E2E harness deploys honor the rest-parameter gate by network and
 * block time.
 *
 * Needs the isolated-vm binding; the require is guarded so the suite SKIPS on a
 * host where it cannot load.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let XChainVM = null, harness = null;
try {
    XChainVM = require('../../../src/index.js');
    harness  = require('../../e2e/helpers/harness.js');
} catch (e) {
    console.log('Skipping E2E harness rest gate tests (isolated-vm unavailable):', e.message);
}

const REST_PROBE = `module.exports = {
    run: function (xchain, ...rest) { return String(rest.length); }
};`;

async function deployRestAt(network, timestamp) {
    const h = new harness.E2EHarness(XChainVM, { network, blockTimestamp: timestamp });
    try {
        return await h.deploy({
            code: REST_PROBE,
            deployer: 'deployer',
            contractAddress: 'C:BTC:1'
        });
    } finally { await h.vm.shutdown(); }
}

(harness ? describe : describe.skip)('toolkit: E2E harness rest-parameter gate', function () {
    this.timeout(30000);

    it('accepts a rest parameter one second before the mainnet gate', async function () {
        const result = await deployRestAt(
            'mainnet', XChainVM.REST_PATTERN_METER_GATE_BLOCK_TIME - 1);
        assert.strictEqual(result.success, true, result.error);
    });

    it('rejects a rest parameter at the mainnet gate', async function () {
        const result = await deployRestAt(
            'mainnet', XChainVM.REST_PATTERN_METER_GATE_BLOCK_TIME);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /rest/i);
    });

    it('rejects a rest parameter on testnet before the mainnet gate', async function () {
        const result = await deployRestAt(
            'testnet', XChainVM.REST_PATTERN_METER_GATE_BLOCK_TIME - 1);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /rest/i);
    });
});
