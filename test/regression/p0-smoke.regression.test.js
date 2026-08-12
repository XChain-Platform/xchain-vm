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
 * [P0] Smoke Regression Tests
 *
 * Fastest-possible verification that the VM is operational.
 * Target: < 5 seconds. Every other regression tier depends on these.
 *
 * Run: npm run test:regression:smoke
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, assertResultShape } = require('./helpers.js');

describe('[P0] Smoke Regression', function() {

    let vm;
    before(function() { vm = createVM(); });

    // VM lifecycle
    describe('VM instantiation', function() {
        it('should construct and run block lifecycle', function() {
            const v = createVM();
            v.beginBlock();
            v.endBlock();
        });
    });

    // Sandbox active
    describe('Sandbox active', function() {
        it('should strip Date', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { return typeof Date; };');
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });
    });

    // Basic execution
    describe('Basic execution', function() {
        it('should execute state read/write and return value', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('k', '42');
                    return xchain.state.get('k');
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), '42');
            assert(r.stateChanges.length > 0);
            assert(r.gasUsed > 0);
        });

        it('should return correct result shape', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { return 1; };');
            assertResultShape(r);
        });
    });

    // Method dispatch
    describe('Method dispatch', function() {
        it('should invoke named method on object export', async function() {
            const r = await execute(vm, `
                module.exports = {
                    alpha: function(xchain) { return 'a'; },
                    beta:  function(xchain) { return 'b'; }
                };
            `, { method: 'alpha' });
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), 'a');
        });
    });

    // Emit pipeline
    describe('Emit pipeline', function() {
        it('should emit a SEND action', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.emit.send({ destination: 'addr', tick: 'TOK', quantity: '100' });
                    return 'ok';
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.emittedActions.length, 1);
            assert.strictEqual(r.emittedActions[0].action, 'SEND');
        });
    });

    // Context accessors
    describe('Context accessors', function() {
        it('should return block height and caller', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    return { h: xchain.getBlockHeight(), c: xchain.getSourceAddress() };
                };
            `, {
                caller: 'ctx_addr',
                blockContext: { height: 77, timestamp: 1700000000, hash: 'h' }
            });
            assert.strictEqual(r.success, true);
            const v = JSON.parse(r.returnValue);
            assert.strictEqual(v.h, 77);
            assert.strictEqual(v.c, 'ctx_addr');
        });
    });

    // Deterministic math
    describe('Deterministic math', function() {
        it('should add via xchain.math.add', async function() {
            const r = await execute(vm,
                'module.exports = function(xchain) { return xchain.math.add("10", "20"); };');
            assert.strictEqual(r.success, true);
            assert.strictEqual(JSON.parse(r.returnValue), '30');
        });
    });

    // Syntax validation
    describe('Syntax validation', function() {
        it('should accept valid code', function() {
            assert.strictEqual(vm.validateSyntax('var x = 1;').valid, true);
        });

        it('should reject invalid code', function() {
            assert.strictEqual(vm.validateSyntax('function {{{').valid, false);
        });
    });

    // Revert atomicity
    describe('Revert atomicity', function() {
        it('should discard state/emissions and preserve logs on revert', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('x', '1');
                    xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
                    xchain.log('kept');
                    xchain.revert('test');
                };
            `);
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.stateChanges.length, 0);
            assert.strictEqual(r.emittedActions.length, 0);
            assert(r.logs.length > 0);
        });
    });
});
