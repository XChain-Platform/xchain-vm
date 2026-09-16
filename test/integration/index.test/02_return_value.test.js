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

    describe('return value', function() {
        it('should serialize string return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return "hello"; };');
            assert.strictEqual(JSON.parse(result.returnValue), 'hello');
        });

        it('should serialize number return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return 42; };');
            assert.strictEqual(JSON.parse(result.returnValue), 42);
        });

        it('should serialize object return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return { a: 1, b: "two" }; };');
            assert.deepStrictEqual(JSON.parse(result.returnValue), { a: 1, b: 'two' });
        });

        it('should serialize array return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return [1, 2, 3]; };');
            assert.deepStrictEqual(JSON.parse(result.returnValue), [1, 2, 3]);
        });

        it('should serialize boolean return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return true; };');
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should return null for undefined return', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { };');
            assert.strictEqual(result.returnValue, null);
        });

        it('should return "null" for null return', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return null; };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should truncate return value exceeding 64KB', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                var s = '';
                for (var i = 0; i < 70000; i++) s += 'x';
                return s;
            };`);
            assert.strictEqual(result.success, true);
            assert(result.returnValue.length <= 65536);
        });
    });
});
