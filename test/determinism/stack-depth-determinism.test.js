/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Regression guard: recursion depth must NOT be contract-observable.
 *
 * A native V8 stack overflow (RangeError) fires at an architecture-dependent
 * depth, and at a depth that also varies with the host stack remaining when
 * execution begins. The host-side out_of_stack clamp only normalizes the failure
 * when the RangeError PROPAGATES to the host. A contract that CATCHES it in-
 * isolate could previously read the raw native depth and commit it into hashed
 * state, so two validators on different CPUs (linux/arm64 vs linux/amd64), or the
 * same node at different host call depths, would commit different values →
 * divergent contract_hash → chain fork.
 *
 * The fix injects a deterministic, in-isolate call-depth bound (metering.js
 * Phase 4 + the harness depth hooks in index.js): recursion is capped at a fixed,
 * platform-independent limit (MAX_STACK_DEPTH) reached well before any supported
 * platform's native limit, and the fault it throws is un-swallowable (the catch
 * re-faults at the meter's __gas(1), exactly like gas exhaustion). So a contract
 * can never observe or commit a depth value, and the failure is the SAME
 * deterministic out_of_stack on every node.
 *
 * This is the catch-the-overflow probe the corpus previously lacked.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { createVM, execute, hashResult, XChainVM } = require('../fuzz/harness');

const CODE = fs.readFileSync(path.join(__dirname, '../contracts/catch_recursion.js'), 'utf8');

describe('determinism: recursion depth is not contract-observable (fork-safe)', function () {
    this.timeout(90000);

    if (!XChainVM) {
        it('REQUIRES isolated-vm (run under the validator Node version)', function () {
            assert.fail('isolated-vm failed to load; cannot verify stack-depth determinism.');
        });
        return;
    }

    it('exposes the deterministic stack-depth bound as a constant', function () {
        assert.strictEqual(typeof XChainVM.MAX_STACK_DEPTH, 'number');
        assert.ok(XChainVM.MAX_STACK_DEPTH > 0);
    });

    it('catching the stack fault commits NO depth and fails deterministically', async function () {
        const RUNS = 10;
        const hashes = new Set();
        for (let i = 0; i < RUNS; i++) {
            const vm = createVM();
            vm.beginBlock();
            const r = await execute(vm, CODE, { method: 'probe' });
            vm.endBlock();

            assert.strictEqual(r.success, false, 'catch-the-overflow contract must fail, not return a depth');
            assert.match(r.error, /^out_of_stack:/, `expected out_of_stack, got: ${r.error}`);
            // The contract tried to xchain.state.set('depth', ...). The fault must be
            // un-swallowable, so that write must never land in hashed state.
            assert.deepStrictEqual(r.stateChanges, [], 'no depth value may be committed to state');
            assert.strictEqual(r.returnValue, null, 'no value may be returned past the fault');
            // gasUsed must clamp to the ceiling (non-deterministic resource
            // termination → fee determinism, same as native overflow).
            assert.strictEqual(r.gasUsed, 1000000, `gasUsed must clamp to the ceiling, got ${r.gasUsed}`);

            hashes.add(hashResult(r));
        }
        assert.strictEqual(hashes.size, 1,
            `NON-DETERMINISTIC result across ${RUNS} runs: ${hashes.size} distinct hashes. ` +
            `A platform-dependent recursion depth leaked into the result → CHAIN FORK risk.`);
    });

    it('legitimate bounded recursion still succeeds (guard does not over-trip)', async function () {
        const vm = createVM();
        vm.beginBlock();
        const r = await execute(vm, CODE, { method: 'bounded' });
        vm.endBlock();
        assert.strictEqual(r.success, true, `bounded recursion must succeed: ${r.error}`);
        assert.deepStrictEqual(r.stateChanges, [{ key: 'sum', value: '5050' }]);
        assert.strictEqual(JSON.parse(r.returnValue), 'ok');
    });
});
