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
 * E2E Tests: Security Enforcement
 * Scenarios: E2E-030 through E2E-034
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertFailed, assertReverted, assertReturnValue,
    assertContractState
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Security Enforcement', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-030: Sandbox escape attempts ---
    describe('E2E-030: Sandbox escape battery', function() {
        it('should block all escape vectors through the full pipeline', async function() {
            const code = h.loadContract('sandbox_escape.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:30' });

            const result = await h.execute({
                contractAddress: 'C:BTC:30', method: 'default',
                params: [], caller: 'user1'
            });
            assertSuccess(result);

            const returnVal = JSON.parse(result.returnValue);
            assert(Array.isArray(returnVal), 'Expected array of results');

            // Every attempt should report "undefined" or "blocked"
            const dangerous = ['process', 'require', 'eval', 'Function',
                               'Date', 'setTimeout', 'fetch', 'Proxy',
                               'WeakRef', 'SharedArrayBuffer'];
            for (const name of dangerous) {
                const entry = returnVal.find(r => r.startsWith(name + ':'));
                assert(entry, `Missing escape test result for ${name}`);
                assert(
                    entry.includes('undefined') || entry.includes('blocked'),
                    `${name} should be blocked/undefined, got: ${entry}`
                );
            }
        });

        it('should not leak host state between executions', async function() {
            // Execute a contract that writes to global-like patterns
            await h.deploy({
                code: `module.exports = function(xchain) {
                    // Try to leak data via various mechanisms
                    try { globalThis.__leaked = 'secret'; } catch(e) {}
                    return 'done';
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:30b'
            });

            await h.execute({
                contractAddress: 'C:BTC:30b', method: 'default',
                params: [], caller: 'user1'
            });

            // Second execution should not see the leaked value
            await h.deploy({
                code: `module.exports = function(xchain) {
                    try {
                        return typeof globalThis.__leaked;
                    } catch(e) {
                        return 'blocked';
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:30c'
            });

            const r2 = await h.execute({
                contractAddress: 'C:BTC:30c', method: 'default',
                params: [], caller: 'user1'
            });
            assertSuccess(r2);
            const val = JSON.parse(r2.returnValue);
            assert(val === 'undefined' || val === 'blocked',
                `Expected no leaked state, got: ${val}`);
        });
    });

    // --- E2E-031: Non-deterministic API usage ---
    describe('E2E-031: Non-deterministic APIs blocked', function() {
        it('should block Date.now()', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    tryDate: function(xchain) { return typeof Date; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:31a'
            });
            const r = await h.execute({
                contractAddress: 'C:BTC:31a', method: 'tryDate',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });

        it('should block Math.random()', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    tryRandom: function(xchain) { return typeof Math.random; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:31b'
            });
            const r = await h.execute({
                contractAddress: 'C:BTC:31b', method: 'tryRandom',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });

        it('should block setTimeout', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    tryTimeout: function(xchain) { return typeof setTimeout; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:31c'
            });
            const r = await h.execute({
                contractAddress: 'C:BTC:31c', method: 'tryTimeout',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });
    });

    // --- E2E-032: Gas identifier injection ---
    describe('E2E-032: Reserved __gas identifier', function() {
        it('should reject contract with __gas variable', function() {
            const result = h.vm.validateSyntax('var __gas = 0; module.exports = function() {};');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('__gas'), 'Expected __gas rejection, got: ' + result.error);
        });
    });

    // --- E2E-033: Invalid emission params ---
    describe('E2E-033: Invalid emission rejected', function() {
        it('should fail when SEND emission is missing required fields', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    badSend: function(xchain) {
                        xchain.emit.send({ tick: 'T', quantity: '1' });
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:33'
            });
            const r = await h.execute({
                contractAddress: 'C:BTC:33', method: 'badSend',
                params: [], caller: 'user1'
            });
            assertFailed(r, 'destination');
        });

        it('should fail when emit params is not an object', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    badEmit: function(xchain) {
                        xchain.emit.send('not an object');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:33b'
            });
            const r = await h.execute({
                contractAddress: 'C:BTC:33b', method: 'badEmit',
                params: [], caller: 'user1'
            });
            assertFailed(r);
        });
    });

    // --- E2E-034: Cross-contract state interference ---
    describe('E2E-034: Cross-contract state isolation', function() {
        it('should prevent one contract from reading another contract state', async function() {
            // Deploy Contract A with a secret
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) { xchain.state.set('secret', 'hunter2'); },
                    getSecret: function(xchain) { return xchain.state.get('secret'); }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:34A'
            });

            // Deploy Contract B that tries to read A's state
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    probe: function(xchain) {
                        // Contract B can only access its own state
                        var val = xchain.state.get('secret');
                        return val;
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:34B'
            });

            // A should see its secret
            const rA = await h.execute({
                contractAddress: 'C:BTC:34A', method: 'getSecret',
                params: [], caller: 'user1'
            });
            assertReturnValue(rA, 'hunter2');

            // B should NOT see A's secret (its own 'secret' key is null)
            const rB = await h.execute({
                contractAddress: 'C:BTC:34B', method: 'probe',
                params: [], caller: 'user1'
            });
            assertSuccess(rB);
            assert.strictEqual(rB.returnValue, 'null',
                'Contract B should not see Contract A state');
        });
    });
});
