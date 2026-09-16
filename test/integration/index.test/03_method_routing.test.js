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

    describe('method routing', function() {
        it('should call default export function (ignore method param)', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return "func_export"; };',
                { method: 'anything' }
            );
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'func_export');
        });

        it('should call named method on object export', async function() {
            const result = await execute(vm, `module.exports = {
                foo: function(xchain) { return 'foo_called'; },
                bar: function(xchain) { return 'bar_called'; }
            };`, { method: 'bar' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'bar_called');
        });

        it('should error on unknown method for object export', async function() {
            const result = await execute(vm, `module.exports = {
                foo: function(xchain) { return 1; }
            };`, { method: 'missing' });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('unknown method'));
        });

        it('should error when contract exports non-function non-object', async function() {
            const result = await execute(vm, 'module.exports = 42;');
            assert.strictEqual(result.success, false);
            assert(result.error.includes('must export'));
        });
    });
});
