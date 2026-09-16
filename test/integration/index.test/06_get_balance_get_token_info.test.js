// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { assert, GAS_SCHEDULE, vmWorking, createVM, setupVM, execute } = require('./support/index_vm.js');

let vm;
(vmWorking ? describe : describe.skip)('XChainVM', function() {
    before(async function() {
        vm = await setupVM.call(this);
    });

    describe('getBalance / getTokenInfo', function() {
        it('should return balance for known address and tick', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("addr1", "TEST"); };',
                { balances: { addr1: { TEST: '500' } } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '500');
        });

        it('should return null for unknown address', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("unknown", "TEST"); };',
                { balances: { addr1: { TEST: '500' } } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return null when no balances provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("addr", "T"); };');
            // balances defaults to {} in execute(), so getBalance returns null
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return token info for known tick', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getTokenInfo("TEST"); };',
                { tokenInfo: { TEST: { supply: '1000', decimals: 8 } } }
            );
            const info = JSON.parse(result.returnValue);
            assert.strictEqual(info.supply, '1000');
            assert.strictEqual(info.decimals, 8);
        });

        it('should return null for unknown token', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getTokenInfo("MISSING"); };',
                { tokenInfo: { TEST: { supply: '1000' } } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });
    });
});
