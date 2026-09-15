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

    describe('logging (extended)', function() {
        it('should stringify object args in log', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.log({ a: 1 });
            };`);
            assert.strictEqual(result.logs[0], '[object Object]');
        });

        it('should report isLogFull correctly', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                for (var i = 0; i < 100; i++) xchain.log('msg');
                return xchain.isLogFull();
            };`);
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should report getLogCount correctly', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.log('a');
                xchain.log('b');
                xchain.log('c');
                return xchain.getLogCount();
            };`);
            assert.strictEqual(JSON.parse(result.returnValue), 3);
        });
    });
});
