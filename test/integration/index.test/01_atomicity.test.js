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

    describe('atomicity', function() {
        it('should discard state and emissions on revert', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.state.set('a', '1');
                xchain.state.set('b', '2');
                xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                xchain.log('before revert');
                xchain.revert('rollback');
            };`);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.stateDeletes.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
            assert.strictEqual(result.logs.length, 1);
            assert.strictEqual(result.logs[0], 'before revert');
        });

        it('should discard state and emissions on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 500 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                xchain.state.set('a', '1');
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert.strictEqual(result.success, false);
            assert(result.error.includes('out_of_gas'));
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should discard state and emissions on contract error', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.state.set('key', 'val');
                xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                throw new Error('contract crash');
            };`);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should preserve logs on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 800 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                xchain.log('logged before gas out');
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert.strictEqual(result.success, false);
            assert(result.logs.length >= 1);
        });
    });
});
