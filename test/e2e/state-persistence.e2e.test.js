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
 * E2E Tests: State Persistence & Isolation
 * Scenarios: E2E-060 through E2E-064
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertReturnValue, assertContractState, assertContractStateDeleted
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: State Persistence & Isolation', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-060: State persists across blocks ---
    describe('E2E-060: State persists across blocks', function() {
        it('should read state set in a previous block', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:60' });

            // Block N: increment to 1
            const r1 = await h.execute({
                contractAddress: 'C:BTC:60', method: 'increment',
                params: [], caller: 'user1'
            });
            assertSuccess(r1);
            assertReturnValue(r1, '1');

            // Advance block
            h.mineBlock();

            // Block N+1: increment to 2 (reads persisted state)
            const r2 = await h.execute({
                contractAddress: 'C:BTC:60', method: 'increment',
                params: [], caller: 'user1'
            });
            assertSuccess(r2);
            assertReturnValue(r2, '2');
            assertContractState(h.ledger, 'C:BTC:60', 'counter', '2');
        });

        it('should accumulate state across many blocks', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:60b' });

            for (let i = 0; i < 5; i++) {
                await h.execute({
                    contractAddress: 'C:BTC:60b', method: 'increment',
                    params: [], caller: 'user1'
                });
                h.mineBlock();
            }

            const r = await h.execute({
                contractAddress: 'C:BTC:60b', method: 'getCount',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assertReturnValue(r, '5');
        });
    });

    // --- E2E-061: State isolation between contracts ---
    describe('E2E-061: State isolation between contracts', function() {
        it('should not share state between different contracts', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:61A' });
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:61B' });

            // Increment A 10 times
            for (let i = 0; i < 10; i++) {
                await h.execute({
                    contractAddress: 'C:BTC:61A', method: 'increment',
                    params: [], caller: 'user1'
                });
            }

            // Increment B 3 times
            for (let i = 0; i < 3; i++) {
                await h.execute({
                    contractAddress: 'C:BTC:61B', method: 'increment',
                    params: [], caller: 'user1'
                });
            }

            // A should be 10, B should be 3
            assertContractState(h.ledger, 'C:BTC:61A', 'counter', '10');
            assertContractState(h.ledger, 'C:BTC:61B', 'counter', '3');

            // Read from each to verify
            const rA = await h.execute({
                contractAddress: 'C:BTC:61A', method: 'getCount',
                params: [], caller: 'user1'
            });
            const rB = await h.execute({
                contractAddress: 'C:BTC:61B', method: 'getCount',
                params: [], caller: 'user1'
            });
            assertReturnValue(rA, '10');
            assertReturnValue(rB, '3');
        });
    });

    // --- E2E-062: State rollback on reorg ---
    describe('E2E-062: State rollback on reorg', function() {
        it('should roll back state to pre-reorg values', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:62' });

            // Block 1: increment to 1
            await h.execute({
                contractAddress: 'C:BTC:62', method: 'increment',
                params: [], caller: 'user1'
            });
            h.mineBlock(); // now at block 2

            // Block 2: increment to 2
            await h.execute({
                contractAddress: 'C:BTC:62', method: 'increment',
                params: [], caller: 'user1'
            });
            assertContractState(h.ledger, 'C:BTC:62', 'counter', '2');

            const reorgBlock = h.ledger.blockHeight; // block 2

            h.mineBlock(); // block 3

            // Block 3: increment to 3
            await h.execute({
                contractAddress: 'C:BTC:62', method: 'increment',
                params: [], caller: 'user1'
            });
            assertContractState(h.ledger, 'C:BTC:62', 'counter', '3');

            // Reorg: roll back blocks >= reorgBlock (blocks 2 and 3)
            // State should revert to what it was after block 1 only
            h.ledger.rollbackToBlock(reorgBlock);

            // Counter should be back to 1 (only block 1 changes survive)
            assertContractState(h.ledger, 'C:BTC:62', 'counter', '1');
        });
    });

    // --- E2E-063: Delete-then-set cycle ---
    describe('E2E-063: Delete-then-set cycle', function() {
        it('should handle set → delete → set correctly', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    setKey: function(xchain) {
                        xchain.state.set('x', xchain.getInputParam(0));
                    },
                    deleteKey: function(xchain) {
                        xchain.state.delete('x');
                    },
                    getKey: function(xchain) {
                        return xchain.state.get('x');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:63'
            });

            // Step 1: set x = '1'
            await h.execute({
                contractAddress: 'C:BTC:63', method: 'setKey',
                params: ['1'], caller: 'user1'
            });
            assertContractState(h.ledger, 'C:BTC:63', 'x', '1');
            h.mineBlock();

            // Step 2: delete x
            await h.execute({
                contractAddress: 'C:BTC:63', method: 'deleteKey',
                params: [], caller: 'user1'
            });
            assertContractStateDeleted(h.ledger, 'C:BTC:63', 'x');
            h.mineBlock();

            // Step 3: set x = '2'
            await h.execute({
                contractAddress: 'C:BTC:63', method: 'setKey',
                params: ['2'], caller: 'user1'
            });
            assertContractState(h.ledger, 'C:BTC:63', 'x', '2');

            // Verify via contract read
            const r = await h.execute({
                contractAddress: 'C:BTC:63', method: 'getKey',
                params: [], caller: 'user1'
            });
            assertReturnValue(r, '2');

            // Verify history has all three operations
            const history = h.ledger.stateHistory['C:BTC:63'];
            const xHistory = history.filter(e => e.key === 'x');
            assert.strictEqual(xHistory.length, 3, 'Expected 3 history entries for key x');
        });
    });

    // --- E2E-064: State dirty tracking ---
    describe('E2E-064: State dirty tracking', function() {
        it('should record write even if value unchanged', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) { xchain.state.set('x', 'same'); },
                    rewrite: function(xchain) {
                        var val = xchain.state.get('x');
                        xchain.state.set('x', val);
                        return val;
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:64'
            });

            h.mineBlock();

            const result = await h.execute({
                contractAddress: 'C:BTC:64', method: 'rewrite',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
            // Even though value is the same, it should appear as a state change
            assert.strictEqual(result.stateChanges.length, 1, 'Write-same should still be tracked');
            assert.strictEqual(result.stateChanges[0].key, 'x');
            assert.strictEqual(result.stateChanges[0].value, 'same');
        });
    });
});
