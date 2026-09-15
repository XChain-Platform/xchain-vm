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

    describe('compilation cache', function() {
        it('should use cache within a block', async function() {
            const code = 'module.exports = function(xchain) { return "cached"; };';
            vm.beginBlock();
            const r1 = await execute(vm, code, { contractIndex: 1 });
            const r2 = await execute(vm, code, { contractIndex: 1 });
            vm.endBlock();
            assert.strictEqual(r1.success, true);
            assert.strictEqual(r2.success, true);
            assert.strictEqual(JSON.parse(r1.returnValue), 'cached');
            assert.strictEqual(JSON.parse(r2.returnValue), 'cached');
        });

        it('should clear cache between blocks', async function() {
            const code = 'module.exports = function(xchain) { return "ok"; };';
            vm.beginBlock();
            await execute(vm, code, { contractIndex: 1 });
            vm.endBlock();
            // After endBlock, cache is null; next execute should still work
            const result = await execute(vm, code);
            assert.strictEqual(result.success, true);
        });
    });
});
