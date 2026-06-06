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
 * E2E Tests: DEPOSIT and WITHDRAW Lifecycle
 * Scenarios: E2E-020 through E2E-023
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertReverted, assertBalance, assertContractBalance,
    assertEmittedActions, assertReturnValue
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Deposit & Withdraw', function() {

    let h;

    beforeEach(async function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'TEST', '500');
        h.seedBalance('user2', 'TEST', '0');

        // Deploy token_sender contract
        const code = h.loadContract('token_sender.js');
        await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:1', params: ['TEST'] });
    });

    // --- E2E-020: Deposit tokens to contract ---
    describe('E2E-020: Deposit tokens to contract', function() {
        it('should transfer tokens from user to contract custody', function() {
            h.deposit('user1', 'C:BTC:1', 'TEST', '200');
            assertBalance(h.ledger, 'user1', 'TEST', '300');
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '200');
        });
    });

    // --- E2E-021: Contract-initiated withdrawal (SEND) ---
    describe('E2E-021: Contract-initiated SEND from custody', function() {
        it('should send tokens from contract custody to recipient', async function() {
            // Deposit tokens to contract
            h.deposit('user1', 'C:BTC:1', 'TEST', '200');

            // Execute contract to SEND 50 TEST to user2
            const result = await h.execute({
                contractAddress: 'C:BTC:1', method: 'send',
                params: ['user2', '50'], caller: 'user1'
            });
            assertSuccess(result);
            assertEmittedActions(result, [
                { action: 'SEND', params: { destination: 'user2', tick: 'TEST', quantity: '50' } }
            ]);

            // Verify balances after SEND processed by mock indexer
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '150');
            assertBalance(h.ledger, 'user2', 'TEST', '50');
        });
    });

    // --- E2E-022: WITHDRAW tokens from contract ---
    describe('E2E-022: Withdraw tokens from contract', function() {
        it('should return tokens from contract custody to user', function() {
            h.deposit('user1', 'C:BTC:1', 'TEST', '200');
            assertBalance(h.ledger, 'user1', 'TEST', '300');
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '200');

            h.withdraw('user1', 'C:BTC:1', 'TEST', '100');
            assertBalance(h.ledger, 'user1', 'TEST', '400');
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '100');
        });
    });

    // --- E2E-023: Overdraw attempt ---
    describe('E2E-023: Overdraw attempt', function() {
        it('should fail when contract tries to SEND more than custody holds', async function() {
            // Deposit only 100
            h.deposit('user1', 'C:BTC:1', 'TEST', '100');

            // Try to send 200 — VM emits the SEND, but the mock indexer catches
            // the overdraw when applying the action to the ledger
            const result = await h.execute({
                contractAddress: 'C:BTC:1', method: 'send',
                params: ['user2', '200'], caller: 'user1'
            });
            assert.strictEqual(result.success, false, 'Overdraw should fail');
            assert(result.error.includes('insufficient'),
                'Expected insufficient balance error, got: ' + result.error);

            // Contract custody balance should not have gone negative
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '100');
        });

        it('should not overdraw on direct withdrawal', function() {
            h.deposit('user1', 'C:BTC:1', 'TEST', '100');
            assert.throws(
                () => h.withdraw('user1', 'C:BTC:1', 'TEST', '200'),
                /insufficient/
            );
            // Balance unchanged
            assertContractBalance(h.ledger, 'C:BTC:1', 'TEST', '100');
        });
    });
});
