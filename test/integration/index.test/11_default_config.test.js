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

const { assert, XChainVM, GAS_SCHEDULE, vmWorking, createVM, setupVM, execute } = require('./support/index_vm.js');

let vm;
(vmWorking ? describe : describe.skip)('XChainVM', function() {
    before(async function() {
        vm = await setupVM.call(this);
    });

    describe('default config', function() {
        it('should use default gasCeiling if not provided', function() {
            const vm2 = new XChainVM({ gasSchedule: GAS_SCHEDULE });
            assert.strictEqual(vm2.gasCeiling, 1000000);
        });

        it('should use default limits if not provided', function() {
            const vm2 = new XChainVM({ gasSchedule: GAS_SCHEDULE });
            assert.strictEqual(vm2.limits.maxCpuTimeMs, 30000);
            assert.strictEqual(vm2.limits.maxMemory, 8);
            assert.strictEqual(vm2.limits.maxEmissions, 50);
        });
    });
});
