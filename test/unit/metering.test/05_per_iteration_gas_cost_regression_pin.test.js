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
const { meterCode } = require('../../../src/metering.js');
const GasTracker = require('../../../src/gas.js');

describe('Metering', function() {

    describe('per-iteration gas cost (regression pin)', function() {
        // A complete gas schedule (mirrors the unit suites). chargeComputation()
        // charges VM_COMPUTATION on every injected __gas() call.
        const SCHEDULE = {
            VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
            VM_STATE_DELETE: 200, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
            VM_ATTEST_REQUEST: 100, VM_EMISSION: 100, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
        };
        const VM_COMPUTATION = SCHEDULE.VM_COMPUTATION;

        // Meter `src`, run it with a __gas stub that mirrors src/index.js
        // (every injected __gas() => gasTracker.chargeComputation()), and return
        // the total gas charged. No isolated-vm needed; meterCode output is plain
        // JS and the charge semantics are identical.
        function gasUsedFor(src) {
            const metered = meterCode(src);
            const tracker = new GasTracker({ ...SCHEDULE }, Number.MAX_SAFE_INTEGER);
            const run = new Function('__gas', metered);
            run(() => tracker.chargeComputation());
            return tracker.getUsed();
        }

        // Empty program meters to a single top-level entry-point __gas charge.
        // Subtracting it isolates the gas attributable purely to the loop.
        const baseline = gasUsedFor('');

        it('ForStatement charges 2x VM_COMPUTATION per iteration (body + update)', function() {
            const N = 5;
            // The metering transform injects __gas(1) twice per for-iteration:
            //   - once at the top of the loop body, and
            //   - once into the update expression: for (;;i++) => for (;;(__gas(1), i++))
            // so a for-loop's per-iteration cost is 2 x VM_COMPUTATION, not 1x.
            const used = gasUsedFor('for (var i = 0; i < ' + N + '; i++) {}') - baseline;
            assert.strictEqual(used, 2 * N * VM_COMPUTATION,
                'for-loop of ' + N + ' iterations should charge 2N x VM_COMPUTATION (body + update)');
        });

        it('a for-loop with no update expression still charges 2x per iteration', function() {
            const N = 5;
            // Even `for (;;)` with no author-written update gets a synthesized
            // __gas(1) in the update slot, so the 2x charge is unconditional.
            const used = gasUsedFor('for (var i = 0; i < ' + N + ';) { i++; }') - baseline;
            assert.strictEqual(used, 2 * N * VM_COMPUTATION,
                'for-loop without an update expression should still charge 2N x VM_COMPUTATION');
        });

        it('WhileStatement charges only 1x VM_COMPUTATION per iteration (no update slot)', function() {
            const N = 5;
            // Contrast: while/do-while have no update expression, so they charge
            // 1x VM_COMPUTATION per iteration; this is the asymmetry the for-loop test pins.
            const used = gasUsedFor('var i = 0; while (i < ' + N + ') { i++; }') - baseline;
            assert.strictEqual(used, N * VM_COMPUTATION,
                'while-loop of ' + N + ' iterations should charge N x VM_COMPUTATION');
        });
    });
});
