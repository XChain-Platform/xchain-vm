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

const assert = require('assert');
const { createVM, execute, assertResultShape } = require('../helpers/harness.js');

let vm;

function initializeVM() {
    if (!vm) vm = createVM();
}

describe('[P3] Integration Regression', function() {
    // FULL EXECUTION PIPELINE
    describe('Full execution pipeline', function() {

        before(function() { initializeVM(); });

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
    });
});

describe('[P3] Integration Regression', function() {
    // FULL EXECUTION PIPELINE
    describe('Full execution pipeline', function() {

        before(function() { initializeVM(); });

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
});
