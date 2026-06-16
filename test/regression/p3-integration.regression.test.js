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
 * [P3] Boundary & Integration Regression Tests
 *
 * Resource limits at configured boundaries, full execution pipeline,
 * compilation cache, E2E critical paths.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createVM, execute, assertAtomicFailure, assertResultShape } = require('./helpers.js');

describe('[P3] Integration Regression', function() {

    // ================================================================
    // RESOURCE LIMITS
    // ================================================================
    describe('Resource limits', function() {

        it('should halt infinite loop via gas ceiling', async function() {
            this.timeout(10000);
            const vm = createVM({ gasCeiling: 1000 });
            const r = await execute(vm,
                'module.exports = function(xchain) { while(true) {} };');
            assert.strictEqual(r.success, false);
            assert(r.error.includes('out_of_gas'));
            assertAtomicFailure(r);
        });

        it('should enforce memory limit', async function() {
            this.timeout(10000);
            const vm = createVM({ limits: { maxMemory: 8 } });
            const code = fs.readFileSync(
                path.join(__dirname, '..', 'contracts', 'memory_bomb.js'), 'utf8');
            const r = await execute(vm, code);
            assert.strictEqual(r.success, false);
        });

        it('should enforce emission limit', async function() {
            const vm = createVM();
            const code = fs.readFileSync(
                path.join(__dirname, '..', 'contracts', 'emit_flood.js'), 'utf8');
            const r = await execute(vm, code);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('emission limit'));
        });

        it('should enforce state key limit', async function() {
            const vm = createVM({ limits: { maxStateKeys: 100 } });
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    for (var i = 0; i < 101; i++) xchain.state.set('k' + i, 'v');
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('max state keys'));
        });

        it('should enforce state value size limit', async function() {
            const vm = createVM({ limits: { maxStateValueSize: 100 } });
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    var big = '';
                    for (var i = 0; i < 200; i++) big += 'x';
                    xchain.state.set('k', big);
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('max size'));
        });

        it('should reject code exceeding maxCodeSize', async function() {
            const vm = createVM();
            const r = await execute(vm, '// ' + 'x'.repeat(65540));
            assert.strictEqual(r.success, false);
            assert(r.error.includes('code size exceeds limit'));
        });

        it('should accept code at exactly maxCodeSize', async function() {
            const vm = createVM();
            const header = 'module.exports = function(xchain) { /* ';
            const footer = ' */ };';
            const padding = 65536 - Buffer.byteLength(header + footer, 'utf8');
            const code = header + 'x'.repeat(padding) + footer;
            const r = await execute(vm, code);
            assert.strictEqual(r.success, true);
        });
    });

    // ================================================================
    // FULL EXECUTION PIPELINE
    // ================================================================
    describe('Full execution pipeline', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should return all 8 result fields on success', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { return 42; };');
            assertResultShape(r);
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.error, null);
        });

        it('should return all 8 result fields on failure', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { xchain.revert("fail"); };');
            assertResultShape(r);
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.returnValue, null);
        });

        it('should handle complex contract with state + emit + math', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    var total = xchain.math.add('100', '50');
                    xchain.state.set('total', total);
                    xchain.emit.send({ destination: 'addr', tick: 'TOK', quantity: total });
                    xchain.log('sent ' + total);
                    return total;
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), '150');
            assert.strictEqual(r.stateChanges.length, 1);
            assert.strictEqual(r.emittedActions.length, 1);
            assert.strictEqual(r.emittedActions[0].params.quantity, '150');
            assert(r.logs[0].includes('150'));
        });

        it('should route to correct method on object export', async function() {
            const code = `
                module.exports = {
                    a: function(xchain) { return 'method_a'; },
                    b: function(xchain) { return 'method_b'; }
                };
            `;
            const ra = await execute(vm, code, { method: 'a' });
            const rb = await execute(vm, code, { method: 'b' });
            assert.strictEqual(JSON.parse(ra.returnValue), 'method_a');
            assert.strictEqual(JSON.parse(rb.returnValue), 'method_b');
        });

        it('should fail on unknown method', async function() {
            const r = await execute(vm, `
                module.exports = {
                    a: function(xchain) { return 1; }
                };
            `, { method: 'nonexistent' });
            assert.strictEqual(r.success, false);
            assert(r.error.includes('unknown method'));
        });

        it('should pass input params to contract', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    return {
                        p0: xchain.getInputParam(0),
                        p1: xchain.getInputParam(1),
                        count: xchain.getInputParamCount()
                    };
                };
            `, { params: ['hello', 'world'] });
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert.strictEqual(v.p0, 'hello');
            assert.strictEqual(v.p1, 'world');
            assert.strictEqual(v.count, 2);
        });

        it('should charge gas on failed execution', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('k', 'v');
                    xchain.revert('fail');
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.gasUsed > 0);
        });
    });

    // ================================================================
    // COMPILATION CACHE
    // ================================================================
    describe('Compilation cache', function() {

        it('should produce same results with and without cache', async function() {
            const vm = createVM();
            const code = `module.exports = function(xchain) {
                xchain.state.set('x', xchain.math.add('1', '2'));
                return xchain.state.get('x');
            };`;
            const opts = { contractIndex: 1 };

            // Cold run
            const r1 = await execute(vm, code, opts);
            // Warm run with beginBlock/endBlock cycle
            vm.beginBlock();
            const r2 = await execute(vm, code, opts);
            vm.endBlock();

            assert.strictEqual(r1.success, r2.success);
            assert.strictEqual(r1.returnValue, r2.returnValue);
            assert.strictEqual(r1.gasUsed, r2.gasUsed);
        });
    });

    // ================================================================
    // GATEWAY CONTEXT
    // ================================================================
    describe('Gateway context', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should expose block context correctly', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    return {
                        h: xchain.getBlockHeight(),
                        t: xchain.getBlockTimestamp(),
                        hash: xchain.getBlockHash()
                    };
                };
            `, { blockContext: { height: 999, timestamp: 1700000000, hash: 'abc' } });
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert.strictEqual(v.h, 999);
            assert.strictEqual(v.t, 1700000000);
            assert.strictEqual(v.hash, 'abc');
        });

        it('should expose source and contract addresses', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    return {
                        src: xchain.getSourceAddress(),
                        con: xchain.getContractAddress()
                    };
                };
            `, { caller: 'caller_addr', contractAddress: 'C:BTC:42' });
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert.strictEqual(v.src, 'caller_addr');
            assert.strictEqual(v.con, 'C:BTC:42');
        });

        it('should provide balance queries when balances supplied', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    return xchain.getBalance('addr1', 'TOK');
                };
            `, { balances: { addr1: { TOK: '500' } } });
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), '500');
        });

        it('should provide xchain.require() for conditional revert', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.require(1 === 1, 'this should pass');
                    xchain.require(1 === 2, 'this should fail');
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('this should fail'));
        });

        it('should provide logging', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.log('msg1');
                    xchain.log('msg2');
                    return xchain.getLogCount();
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.logs.length, 2);
            assert.strictEqual(r.logs[0], 'msg1');
            assert.strictEqual(r.logs[1], 'msg2');
        });
    });

    // ================================================================
    // E2E CRITICAL PATH (contract lifecycle)
    // ================================================================
    describe('E2E critical path', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should deploy and execute a multi-method contract', async function() {
            // Simulate deploy: validate syntax
            const code = `
                module.exports = {
                    initialize: function(xchain) {
                        xchain.state.set('count', '0');
                        xchain.state.set('owner', xchain.getSourceAddress());
                        return 'initialized';
                    },
                    increment: function(xchain) {
                        var c = xchain.state.get('count');
                        var next = xchain.math.add(c, '1');
                        xchain.state.set('count', next);
                        return next;
                    },
                    getCount: function(xchain) {
                        return xchain.state.get('count');
                    }
                };
            `;
            assert.strictEqual(vm.validateSyntax(code).valid, true);

            // Initialize
            const init = await execute(vm, code, {
                method: 'initialize', caller: 'deployer'
            });
            assert.strictEqual(init.success, true);

            // Increment (using state from init)
            const state = {};
            for (const ch of init.stateChanges) state[ch.key] = ch.value;

            const inc1 = await execute(vm, code, {
                method: 'increment', caller: 'user1', state
            });
            assert.strictEqual(inc1.success, true);
            assert.strictEqual(JSON.parse(inc1.returnValue), '1');

            // Increment again
            for (const ch of inc1.stateChanges) state[ch.key] = ch.value;
            const inc2 = await execute(vm, code, {
                method: 'increment', caller: 'user2', state
            });
            assert.strictEqual(inc2.success, true);
            assert.strictEqual(JSON.parse(inc2.returnValue), '2');
        });

        it('should execute contract with state persistence across calls', async function() {
            const code = `module.exports = {
                set: function(xchain) {
                    xchain.state.set(xchain.getInputParam(0), xchain.getInputParam(1));
                    return 'set';
                },
                get: function(xchain) {
                    return xchain.state.get(xchain.getInputParam(0));
                }
            };`;

            // Set
            const set = await execute(vm, code, {
                method: 'set', params: ['key1', 'value1']
            });
            assert.strictEqual(set.success, true);

            // Build state from changes
            const state = {};
            for (const ch of set.stateChanges) state[ch.key] = ch.value;

            // Get
            const get = await execute(vm, code, {
                method: 'get', params: ['key1'], state
            });
            assert.strictEqual(get.success, true);
            assert.strictEqual(JSON.parse(get.returnValue), 'value1');
        });

        it('should handle AMM-style contract', async function() {
            const code = fs.readFileSync(
                path.join(__dirname, '..', 'contracts', 'amm_swap.js'), 'utf8');
            const r = await execute(vm, code, {
                method: 'swap',
                params: ['100', 'TOKENA'],
                state: {
                    tokenA: 'TOKENA', tokenB: 'TOKENB',
                    reserveA: '10000', reserveB: '5000'
                }
            });
            assert.strictEqual(r.success, true);
            assert(r.gasUsed > 0);
        });
    });

    // ================================================================
    // STATE ISOLATION
    // ================================================================
    describe('State isolation', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should not leak state between executions', async function() {
            // First execution sets state
            const r1 = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('secret', 'confidential');
                    return 'set';
                };
            `, { contractAddress: 'C:BTC:1' });
            assert.strictEqual(r1.success, true);

            // Second execution with different contract sees no state
            const r2 = await execute(vm, `
                module.exports = function(xchain) {
                    return xchain.state.get('secret');
                };
            `, { contractAddress: 'C:BTC:2' });
            assert.strictEqual(r2.success, true);
            assert.strictEqual(JSON.parse(r2.returnValue), null);
        });
    });
});
