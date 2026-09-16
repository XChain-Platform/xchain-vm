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

    describe('error classification', function() {
        it('should prefix revert errors with "revert:"', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.revert("bad"); };');
            assert(result.error.startsWith('revert:'));
        });

        it('should prefix gas errors with "out_of_gas:"', async function() {
            const vm2 = createVM({ gasCeiling: 50 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert(result.error.startsWith('out_of_gas:'));
        });

        it('should prefix generic errors with "error:"', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("oops"); };');
            assert(result.error.startsWith('error:'));
        });

        it('should use "revert: reverted" for revert() with no reason', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.revert(); };');
            assert(result.error.includes('revert: reverted'));
        });

        it('should use "revert: requirement failed" for require(false) with no reason', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.require(false); };');
            assert(result.error.includes('revert: requirement failed'));
        });

        it('should not misclassify contract-thrown \\x03GAS error as gas exhaustion', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("\\x03GAS:999:100"); };');
            assert(result.error.startsWith('error:'), 'expected generic error, got: ' + result.error);
        });

        it('should not misclassify contract-thrown \\x03REVERT as revert', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };');
            assert(result.error.startsWith('error:'), 'expected generic error, got: ' + result.error);
        });
    });
});
