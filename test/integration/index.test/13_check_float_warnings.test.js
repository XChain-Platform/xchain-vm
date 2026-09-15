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

    describe('checkFloatWarnings', function() {
        it('should return warnings for float literals', function() {
            const warnings = vm.checkFloatWarnings('var x = 3.14;');
            assert.strictEqual(warnings.length, 1);
            assert(warnings[0].includes('3.14'));
        });

        it('should return empty array for integer-only code', function() {
            const warnings = vm.checkFloatWarnings('var x = 42;');
            assert.strictEqual(warnings.length, 0);
        });
    });
});
