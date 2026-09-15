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

    describe('validateSyntax', function() {
        it('should accept valid code', function() {
            assert.strictEqual(vm.validateSyntax('var x = 1;').valid, true);
        });

        it('should reject invalid code', function() {
            const result = vm.validateSyntax('function { bad }');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('syntax error'));
        });
    });
});
