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

const { assert, GAS_SCHEDULE, vmWorking, createVM, setupVM, execute } = require('./index.test/support/index_vm.js');

let vm;
(vmWorking ? describe : describe.skip)('XChainVM', function() {
    before(async function() {
        vm = await setupVM.call(this);
    });

    describe('result structure', function() {
        it('should return all 8 fields on success', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return 42; };');
            assert.strictEqual(typeof result.success, 'boolean');
            assert.strictEqual(result.error, null);
            assert.strictEqual(typeof result.gasUsed, 'number');
            assert(Array.isArray(result.stateChanges));
            assert(Array.isArray(result.stateDeletes));
            assert(Array.isArray(result.emittedActions));
            assert(Array.isArray(result.logs));
            assert('returnValue' in result);
        });

        it('should return all 8 fields on failure', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { xchain.revert("fail"); };');
            assert.strictEqual(result.success, false);
            assert.strictEqual(typeof result.error, 'string');
            assert.strictEqual(typeof result.gasUsed, 'number');
            assert.strictEqual(result.returnValue, null);
            assert(Array.isArray(result.stateChanges));
            assert(Array.isArray(result.stateDeletes));
            assert(Array.isArray(result.emittedActions));
            assert(Array.isArray(result.logs));
        });
    });
});
