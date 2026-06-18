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
 * E2E Tests: Complex Contract Logic with Multiple Actions
 * Scenarios: E2E-010 through E2E-014
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertReverted, assertReturnValue, assertContractState,
    assertBalance, assertContractBalance, assertEmittedActions, assertLogsContain
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests (isolated-vm not available)'); }

(XChainVM ? describe : describe.skip)('E2E: Complex Workflows', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
        h.seedBalance('user2', 'XCHAIN', '1000000');
    });

    // --- E2E-010: AMM swap contract ---
    describe('E2E-010: AMM constant-product swap', function() {
        it('should add liquidity and execute swap with correct math', async function() {
            const code = h.loadContract('amm.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:10',
                params: ['TOKENA', 'TOKENB']
            });

            // Deposit tokens to contract custody
            h.ledger.creditContractBalance('C:BTC:10', 'TOKENA', '10000');
            h.ledger.creditContractBalance('C:BTC:10', 'TOKENB', '10000');

            // Add liquidity: 1000 TOKENA + 1000 TOKENB
            const addResult = await h.execute({
                contractAddress: 'C:BTC:10', method: 'addLiquidity',
                params: ['1000', '1000'], caller: 'deployer'
            });
            assertSuccess(addResult);
            assertContractState(h.ledger, 'C:BTC:10', 'reserveA', '1000');
            assertContractState(h.ledger, 'C:BTC:10', 'reserveB', '1000');

            // Swap 100 TOKENA for TOKENB
            // k = 1000 * 1000 = 1000000
            // newResA = 1000 + 100 = 1100
            // newResB = 1000000 / 1100 ≈ 909.090909...
            // output = 1000 - 909.090909... ≈ 90.909090...
            const swapResult = await h.execute({
                contractAddress: 'C:BTC:10', method: 'swap',
                params: ['100', 'TOKENA'], caller: 'user1'
            });
            assertSuccess(swapResult);
            assert.strictEqual(swapResult.emittedActions.length, 1);
            assert.strictEqual(swapResult.emittedActions[0].action, 'SEND');
            assert.strictEqual(swapResult.emittedActions[0].params.tick, 'TOKENB');

            // Verify reserves changed
            assertContractState(h.ledger, 'C:BTC:10', 'reserveA', '1100');
            assertLogsContain(swapResult, 'swapped');
        });

        it('should revert swap with no liquidity', async function() {
            const code = h.loadContract('amm.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:10b',
                params: ['TOKENA', 'TOKENB']
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:10b', method: 'swap',
                params: ['100', 'TOKENA'], caller: 'user1'
            });
            assertReverted(result, 'no liquidity');
        });
    });

    // --- E2E-011: Vesting contract with time-locked release ---
    describe('E2E-011: Vesting with time-locked release', function() {
        it('should revert before cliff, succeed after cliff', async function() {
            const code = h.loadContract('vesting.js');
            // Deploy at block 1 with cliff=10 blocks, vesting=100 blocks
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:11',
                params: ['user1', 'TEST', '1000', '10', '100']
            });

            // Deposit tokens to contract custody
            h.ledger.creditContractBalance('C:BTC:11', 'TEST', '1000');

            // Try to claim before cliff (still at block 1)
            const r1 = await h.execute({
                contractAddress: 'C:BTC:11', method: 'claim',
                params: [], caller: 'user1'
            });
            assertReverted(r1, 'cliff not reached');

            // Advance 11 blocks (past the cliff of 10)
            for (let i = 0; i < 11; i++) h.mineBlock();

            // Now claim should work: 11 blocks elapsed out of 100
            // vested = 1000 * 11 / 100 = 110
            const r2 = await h.execute({
                contractAddress: 'C:BTC:11', method: 'claim',
                params: [], caller: 'user1'
            });
            assertSuccess(r2);
            assert.strictEqual(r2.emittedActions.length, 1);
            assert.strictEqual(r2.emittedActions[0].action, 'SEND');
            assert.strictEqual(r2.emittedActions[0].params.destination, 'user1');

            // Verify claimed amount updated
            const claimed = h.ledger.getContractStateKey('C:BTC:11', 'claimed');
            assert(claimed !== '0', 'Claimed should be updated');
        });

        it('should reject claim from non-beneficiary', async function() {
            const code = h.loadContract('vesting.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:11b',
                params: ['user1', 'TEST', '1000', '1', '100']
            });

            for (let i = 0; i < 5; i++) h.mineBlock();

            const result = await h.execute({
                contractAddress: 'C:BTC:11b', method: 'claim',
                params: [], caller: 'user2'  // Not the beneficiary
            });
            assertReverted(result, 'only beneficiary');
        });
    });

    // --- E2E-012: Contract emitting multiple action types ---
    describe('E2E-012: Multiple emission types in one execution', function() {
        it('should emit SEND + DESTROY correctly', async function() {
            const code = h.loadContract('multi_action.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:12',
                params: ['TEST']
            });

            // Give contract custody tokens
            h.ledger.creditContractBalance('C:BTC:12', 'TEST', '500');

            const result = await h.execute({
                contractAddress: 'C:BTC:12', method: 'sendAndDestroy',
                params: ['user1', '100', '50'], caller: 'deployer'
            });
            assertSuccess(result);
            assertEmittedActions(result, [
                { action: 'SEND', params: { destination: 'user1', tick: 'TEST', quantity: '100' } },
                { action: 'DESTROY', params: { tick: 'TEST', quantity: '50' } }
            ]);

            // After indexer processes: contract had 500, sent 100, destroyed 50 = 350
            assertContractBalance(h.ledger, 'C:BTC:12', 'TEST', '350');
            assertBalance(h.ledger, 'user1', 'TEST', '100');
        });
    });

    // --- E2E-013: Sequential executions with cumulative state ---
    describe('E2E-013: Sequential counter increments across blocks', function() {
        it('should maintain counter across 5 increments and 2 decrements', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:13' });

            // 5 increments across 5 blocks
            for (let i = 0; i < 5; i++) {
                const r = await h.execute({
                    contractAddress: 'C:BTC:13', method: 'increment',
                    params: [], caller: 'user1'
                });
                assertSuccess(r);
                h.mineBlock();
            }
            assertContractState(h.ledger, 'C:BTC:13', 'counter', '5');

            // 2 decrements
            for (let i = 0; i < 2; i++) {
                const r = await h.execute({
                    contractAddress: 'C:BTC:13', method: 'decrement',
                    params: [], caller: 'user1'
                });
                assertSuccess(r);
                h.mineBlock();
            }
            assertContractState(h.ledger, 'C:BTC:13', 'counter', '3');

            // Verify via contract read
            const r = await h.execute({
                contractAddress: 'C:BTC:13', method: 'getCount',
                params: [], caller: 'user1'
            });
            assertReturnValue(r, '3');
        });
    });

    // --- E2E-014: Conditional logic branching ---
    describe('E2E-014: Conditional branching', function() {
        it('should branch based on input params', async function() {
            const code = h.loadContract('multi_action.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:14',
                params: ['TEST']
            });
            h.ledger.creditContractBalance('C:BTC:14', 'TEST', '1000');

            // Branch A: send
            const r1 = await h.execute({
                contractAddress: 'C:BTC:14', method: 'conditionalAction',
                params: ['send', 'user1', '25'], caller: 'deployer'
            });
            assertSuccess(r1);
            assertReturnValue(r1, 'sent');
            assert.strictEqual(r1.emittedActions[0].action, 'SEND');

            // Branch B: destroy
            const r2 = await h.execute({
                contractAddress: 'C:BTC:14', method: 'conditionalAction',
                params: ['destroy', '10'], caller: 'deployer'
            });
            assertSuccess(r2);
            assertReturnValue(r2, 'destroyed');
            assert.strictEqual(r2.emittedActions[0].action, 'DESTROY');

            // Unknown action: should revert
            const r3 = await h.execute({
                contractAddress: 'C:BTC:14', method: 'conditionalAction',
                params: ['invalid'], caller: 'deployer'
            });
            assertReverted(r3, 'unknown action');
        });
    });
});
