/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E Tests: enforced-royalty controller (controller-bound tokens)
 *
 * Exercises contracts/royalty_controller.js against the real VM as a
 * token CONTROLLER's `guard` method: taxes sales, frees gifts/listings,
 * floors the cut with mod-remainder math, and conserves proceeds.
 *
 * The proceeds-routing the indexer will perform at settlement is
 * simulated by crediting the controller's derived address before the
 * guard runs (creditContractBalance), so the guard's getBalance() check
 * passes and its emitted SENDs can debit the routed funds.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertReverted, assertEmittedActions,
    assertContractState, assertContractBalance
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping royalty-controller E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: enforced-royalty controller', function() {

    let h;
    const CTRL = 'C:BTC:1';

    // Deploy a fresh royalty controller; returns the deploy result.
    async function deployController(addr, creator, bps) {
        const code = h.loadContract('royalty_controller.js');
        return h.deploy({ code, deployer: 'deployer', contractAddress: addr,
                          params: [creator, bps] });
    }

    // Run the guard with the positional ABI:
    //   (action_type, from, to, tick, amount, price, proceeds_tick)
    function guard(addr, args, caller) {
        return h.execute({ contractAddress: addr, method: 'guard',
                           params: args, caller: caller || 'buyer' });
    }

    beforeEach(async function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('buyer',    'XCHAIN', '1000000');
        // 10% royalty (1000 bps), creator = 'creator'.
        const dep = await deployController(CTRL, 'creator', '1000');
        assert.strictEqual(dep.success, true, `deploy failed: ${dep.error}`);
    });

    describe('initialization', function() {
        it('stores creator, bps and a zeroed paidTotal', function() {
            assertContractState(h.ledger, CTRL, 'creator', 'creator');
            assertContractState(h.ledger, CTRL, 'bps', '1000');
            assertContractState(h.ledger, CTRL, 'paidTotal', '0');
        });

        it('rejects bps over 100% (10000)', async function() {
            const dep = await deployController('C:BTC:99', 'creator', '10001');
            assert.strictEqual(dep.success, false);
            assert(dep.error.includes('bps exceeds 100%'), `got: ${dep.error}`);
        });

        it('cannot be initialized twice', async function() {
            const r = await h.execute({ contractAddress: CTRL, method: 'initialize',
                                        params: ['attacker', '0'], caller: 'deployer' });
            assertReverted(r, 'already initialized');
        });
    });

    describe('sales are taxed (proceeds routed)', function() {
        it('ORDER_MATCH splits the cut to creator and remainder to seller', async function() {
            h.ledger.creditContractBalance(CTRL, 'XCHAIN', '100'); // routed proceeds
            const r = await guard(CTRL,
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '100', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'creator', tick: 'XCHAIN', quantity: '10' } },
                { action: 'SEND', params: { destination: 'seller',  tick: 'XCHAIN', quantity: '90' } }
            ]);
            // Conservation: the controller forwarded 100% — nothing stranded.
            assertContractBalance(h.ledger, CTRL, 'XCHAIN', '0');
            // Bookkeeping: lifetime royalties forwarded.
            assertContractState(h.ledger, CTRL, 'paidTotal', '10');
        });

        it('SWAP_MATCH is taxed the same way', async function() {
            h.ledger.creditContractBalance(CTRL, 'XCHAIN', '100');
            const r = await guard(CTRL,
                ['SWAP_MATCH', 'seller', 'buyer', 'NFT', '1', '100', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'creator', quantity: '10' } },
                { action: 'SEND', params: { destination: 'seller',  quantity: '90' } }
            ]);
        });

        it('DISPENSE is taxed the same way', async function() {
            h.ledger.creditContractBalance(CTRL, 'XCHAIN', '100');
            const r = await guard(CTRL,
                ['DISPENSE', 'seller', 'buyer', 'NFT', '1', '100', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'creator', quantity: '10' } },
                { action: 'SEND', params: { destination: 'seller',  quantity: '90' } }
            ]);
        });

        it('conserves exactly on a fractional price', async function() {
            // price 100.5 @ 10% -> cut floor(100500/10000*... )= 10, seller 90.5; sums to 100.5.
            h.ledger.creditContractBalance(CTRL, 'XCHAIN', '100.5');
            const r = await guard(CTRL,
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '100.5', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'creator', quantity: '10' } },
                { action: 'SEND', params: { destination: 'seller',  quantity: '90.5' } }
            ]);
            assertContractBalance(h.ledger, CTRL, 'XCHAIN', '0');
        });

        it('floors an awkward bps cleanly (33.33% of 100 -> 33 / 67)', async function() {
            await deployController('C:BTC:2', 'creator', '3333');
            h.ledger.creditContractBalance('C:BTC:2', 'XCHAIN', '100');
            const r = await guard('C:BTC:2',
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '100', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'creator', quantity: '33' } },
                { action: 'SEND', params: { destination: 'seller',  quantity: '67' } }
            ]);
        });

        it('a dust-sized trade floors the cut to zero (no creator emit)', async function() {
            // floor(1 * 1000 / 10000) = floor(0.1) = 0 -> seller gets the whole 1.
            h.ledger.creditContractBalance(CTRL, 'XCHAIN', '1');
            const r = await guard(CTRL,
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '1', 'XCHAIN']);
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'seller', tick: 'XCHAIN', quantity: '1' } }
            ]);
            assertContractState(h.ledger, CTRL, 'paidTotal', '0');
        });
    });

    describe('non-sales pass free (untaxed)', function() {
        it('a plain SEND (gift / wallet move) emits nothing', async function() {
            const r = await guard(CTRL, ['SEND', 'alice', 'bob', 'NFT', '1', '', '']);
            assertSuccess(r);
            assert.strictEqual(r.emittedActions.length, 0);
        });

        it('listing gates (ORDER_CREATE) pass free', async function() {
            const r = await guard(CTRL, ['ORDER_CREATE', 'seller', '', 'NFT', '1', '', '']);
            assertSuccess(r);
            assert.strictEqual(r.emittedActions.length, 0);
        });

        it('native-coin proceeds (empty proceeds_tick) are out of scope — pass free', async function() {
            const r = await guard(CTRL,
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '100', '']);
            assertSuccess(r);
            assert.strictEqual(r.emittedActions.length, 0);
        });
    });

    describe('fail-closed', function() {
        it('reverts the sale if proceeds were not routed to the controller', async function() {
            // No creditContractBalance — the controller holds nothing.
            const r = await guard(CTRL,
                ['ORDER_MATCH', 'seller', 'buyer', 'NFT', '1', '100', 'XCHAIN']);
            assertReverted(r, 'proceeds not routed');
        });
    });
});
