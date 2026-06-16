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
 * E2E Tests: Error Handling & Recovery
 * Scenarios: E2E-050 through E2E-055
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertFailed, assertReverted, assertReturnValue,
    assertContractState, assertLogsContain
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Error Handling & Recovery', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-050: Contract throws runtime error ---
    describe('E2E-050: Runtime error', function() {
        it('should catch contract throw and return error result', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    boom: function(xchain) {
                        xchain.state.set('before', 'yes');
                        throw new Error('contract crash');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:50'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:50', method: 'boom',
                params: [], caller: 'user1'
            });
            assertFailed(result, 'contract crash');
            assert.strictEqual(result.stateChanges.length, 0, 'State should be discarded on error');
            assert.strictEqual(result.emittedActions.length, 0);
            // State key 'before' should NOT have been persisted
            assertContractState(h.ledger, 'C:BTC:50', 'before', null);
        });
    });

    // --- E2E-051: Contract calls xchain.revert() ---
    describe('E2E-051: xchain.revert()', function() {
        it('should revert with clear message and discard state', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) { xchain.state.set('val', '0'); },
                    failingMethod: function(xchain) {
                        xchain.state.set('val', '999');
                        xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                        xchain.log('about to revert');
                        xchain.revert('insufficient balance');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:51'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:51', method: 'failingMethod',
                params: [], caller: 'user1'
            });
            assertReverted(result, 'insufficient balance');
            assertLogsContain(result, 'about to revert');
            // State should still be '0' (the initialize value), not '999'
            assertContractState(h.ledger, 'C:BTC:51', 'val', '0');
        });
    });

    // --- E2E-052: xchain.require() failure ---
    describe('E2E-052: xchain.require() failure', function() {
        it('should revert when require condition is false', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    guarded: function(xchain) {
                        xchain.require(false, 'precondition failed');
                        return 'unreachable';
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:52'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:52', method: 'guarded',
                params: [], caller: 'user1'
            });
            assertReverted(result, 'precondition failed');
            assert.strictEqual(result.returnValue, null);
        });
    });

    // --- E2E-053: Math error (division by zero) ---
    describe('E2E-053: Math division by zero', function() {
        it('should revert with math error', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    divZero: function(xchain) {
                        return xchain.math.divide('10', '0');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:53'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:53', method: 'divZero',
                params: [], caller: 'user1'
            });
            assertFailed(result);
            assert(result.error.includes('revert') || result.error.includes('math') || result.error.includes('divide'),
                'Expected math/revert error, got: ' + result.error);
        });
    });

    // --- E2E-054: Execution after previous failure ---
    describe('E2E-054: Recovery after failure', function() {
        it('should execute cleanly after a prior revert', async function() {
            const code = h.loadContract('counter.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:54' });

            // First: decrement on 0 should revert
            const r1 = await h.execute({
                contractAddress: 'C:BTC:54', method: 'decrement',
                params: [], caller: 'user1'
            });
            assertReverted(r1, 'counter is zero');

            // Counter should still be 0
            assertContractState(h.ledger, 'C:BTC:54', 'counter', '0');

            // Second: increment should work fine
            const r2 = await h.execute({
                contractAddress: 'C:BTC:54', method: 'increment',
                params: [], caller: 'user1'
            });
            assertSuccess(r2);
            assertReturnValue(r2, '1');
            assertContractState(h.ledger, 'C:BTC:54', 'counter', '1');
        });
    });

    // --- E2E-055: Compilation/metering failure ---
    describe('E2E-055: Metering failure on execute', function() {
        it('should fail gracefully if code can not be metered', async function() {
            // Deploy a contract with code that will be stored but may fail at metering
            // The harness deploys and runs initialize — if code is invalid it fails at deploy
            // For this test we directly store broken code in the ledger
            h.ledger.deployContract('C:BTC:55', '???INVALID_NOT_JS???', 'deployer', 1);

            const result = await h.execute({
                contractAddress: 'C:BTC:55', method: 'default',
                params: [], caller: 'user1'
            });
            assertFailed(result);
            assert.strictEqual(result.stateChanges.length, 0);
        });
    });
});
