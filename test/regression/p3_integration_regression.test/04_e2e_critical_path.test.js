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
const fs = require('fs');
const path = require('path');
const { createVM, execute } = require('../helpers/harness.js');

let vm;

function initializeVM() {
    if (!vm) vm = createVM();
}

describe('[P3] Integration Regression', function() {
    // E2E CRITICAL PATH (contract lifecycle)
    describe('E2E critical path', function() {

        before(function() { initializeVM(); });

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

            const init = await execute(vm, code, {
                method: 'initialize', caller: 'deployer'
            });
            assert.strictEqual(init.success, true);

            const state = {};
            for (const ch of init.stateChanges) state[ch.key] = ch.value;

            const inc1 = await execute(vm, code, {
                method: 'increment', caller: 'user1', state
            });
            assert.strictEqual(inc1.success, true);
            assert.strictEqual(JSON.parse(inc1.returnValue), '1');

            for (const ch of inc1.stateChanges) state[ch.key] = ch.value;
            const inc2 = await execute(vm, code, {
                method: 'increment', caller: 'user2', state
            });
            assert.strictEqual(inc2.success, true);
            assert.strictEqual(JSON.parse(inc2.returnValue), '2');
        });
    });
});

describe('[P3] Integration Regression', function() {
    // E2E CRITICAL PATH (contract lifecycle)
    describe('E2E critical path', function() {

        before(function() { initializeVM(); });

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

            const set = await execute(vm, code, {
                method: 'set', params: ['key1', 'value1']
            });
            assert.strictEqual(set.success, true);

            const state = {};
            for (const ch of set.stateChanges) state[ch.key] = ch.value;

            const get = await execute(vm, code, {
                method: 'get', params: ['key1'], state
            });
            assert.strictEqual(get.success, true);
            assert.strictEqual(JSON.parse(get.returnValue), 'value1');
        });

        it('should handle AMM-style contract', async function() {
            const code = fs.readFileSync(
                path.join(__dirname, '../../fixtures/contracts/amm_swap.js'), 'utf8');
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
});
