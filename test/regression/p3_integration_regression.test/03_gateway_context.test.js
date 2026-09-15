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
const { createVM, execute } = require('../helpers/harness.js');

let vm;

function initializeVM() {
    if (!vm) vm = createVM();
}

describe('[P3] Integration Regression', function() {
    // GATEWAY CONTEXT
    describe('Gateway context', function() {

        before(function() { initializeVM(); });

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
    });
});

describe('[P3] Integration Regression', function() {
    // GATEWAY CONTEXT
    describe('Gateway context', function() {

        before(function() { initializeVM(); });

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
});
