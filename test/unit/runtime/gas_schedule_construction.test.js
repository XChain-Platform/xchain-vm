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

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
const GasTracker = require('../../../src/gas.js');

const schedule = Object.fromEntries(GasTracker.CANONICAL_GAS_KEYS.map((key) => [key, 1]));

describe('XChainVM gas schedule construction', function() {
    for (const execution of ['in-process', 'subprocess']) {
        it(`rejects a missing key before starting the ${execution} host`, function() {
            const incomplete = { ...schedule };
            delete incomplete.VM_XCALL_CALLBACK;
            assert.throws(
                () => new XChainVM({ execution, gasSchedule: incomplete, gasCeiling: 1000000 }),
                /gas schedule is missing required key: VM_XCALL_CALLBACK/,
            );
        });

        it(`rejects invalid values before starting the ${execution} host`, function() {
            assert.throws(
                () => new XChainVM({ execution, gasSchedule: { ...schedule, VM_STATE_READ: -1 } }),
                /must be a non-negative integer/,
            );
            assert.throws(
                () => new XChainVM({ execution, gasSchedule: { ...schedule, VM_STATE_READ: 1.5 } }),
                /must be a non-negative integer/,
            );
        });
    }

    it('accepts a complete schedule with caller-owned keys', function() {
        const vm = new XChainVM({
            execution: 'in-process',
            gasSchedule: { ...schedule, ISSUE: 100, VM_EXECUTE_BASE: 10 },
            gasCeiling: 1000000,
        });
        assert.strictEqual(vm.gasSchedule.ISSUE, 100);
    });
});
