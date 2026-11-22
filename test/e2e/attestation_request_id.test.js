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
 * E2E: attestation request_id is unique per emitting contract and per tx
 * in a shared harness, so a seeded response never leaks across contracts.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests: isolated-vm not available'); }

const CODE = `module.exports = {
    initialize: function(xchain) {},
    ask: function(xchain) {
        return xchain.attestation.request('http_get', 'https://example.com', 'cb', [], { redundancy: 1, deadlineBlocks: 10 });
    },
    cb: function(xchain) {}
};`;

describe('E2E: attestation request_id isolation', function () {
    this.timeout(30000);
    let h;
    before(function () { if (!XChainVM) this.skip(); });

    beforeEach(async () => {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        await h.deploy({ code: CODE, contractAddress: 'C:BTC:7', deployer: 'deployer' });
        await h.deploy({ code: CODE, contractAddress: 'C:BTC:8', deployer: 'deployer' });
    });

    async function ask(addr, extra) {
        const r = await h.execute({ contractAddress: addr, method: 'ask', caller: 'deployer', ...(extra || {}) });
        assert.strictEqual(r.success, true, r.error);
        return r.returnValue;
    }

    it('two contracts in one harness get different request ids', async () => {
        const a = await ask('C:BTC:7');
        const b = await ask('C:BTC:8');
        assert.notStrictEqual(a, b);
    });

    it('a response seeded for one contract is not read by another', async () => {
        const a = await ask('C:BTC:7');
        const b = await ask('C:BTC:8');
        h.ledger.seedAttestation(a, { status: 'failed' });
        assert.ok(h.ledger.buildAttestationAccessor().getResponse(a));
        assert.strictEqual(h.ledger.buildAttestationAccessor().getResponse(b), null);
    });

    it('the same contract gets different ids under different tx hashes', async () => {
        const a = await ask('C:BTC:7', { txHash: 'aa'.repeat(32) });
        const b = await ask('C:BTC:7', { txHash: 'bb'.repeat(32) });
        assert.notStrictEqual(a, b);
    });
});
