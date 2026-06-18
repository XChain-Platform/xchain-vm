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
 * Regression guard: resource-termination gasUsed must be deterministic.
 *
 * Wall-clock timeout, isolate memory limit, and native stack overflow fire
 * at machine-/GC-/stack-depth-dependent points. The indexer computes
 * fee = gasUsed * GAS_PRICE (consensus-critical), so a nondeterministic
 * gasUsed would diverge fees across validators → chain fork. index.js
 * therefore CLAMPS gasUsed to the gas ceiling for every non-gas, non-revert
 * resource termination. This guard locks that invariant in: each vector is
 * run repeatedly and must yield exactly ONE gasUsed value (== the ceiling).
 *
 * History: this was 2026-06-06's KNOWN-RED Finding B; it flipped green when
 * the deterministic clamp landed in src/index.js (_classifyError).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

// Each contract is bounded by a NON-gas, NON-deterministic ceiling. (The bulk
// allocators new Array().fill / repeat / Array.from are now gas-bounded by F3, so
// the wall-clock vector uses a SPREAD of a holey array (F3 can't wrap spread
// syntax, so this path still terminates via the isolate wall-clock / host backstop
// and exercises the clamp.) out_of_gas is clamped to the ceiling too (F3), so all
// three families report gasUsed == ceiling deterministically.
const VECTORS = [
    {
        id: 'wall-clock / host termination (spread of a holey array)',
        match: /^(timeout|out_of_memory|out_of_resource):/,
        code: `module.exports = function(xchain) { var a = [...new Array(100000000)]; return a.length; };`
    },
    {
        id: 'native stack overflow (infinite recursion)',
        match: /^out_of_stack:/,
        code: `module.exports = function(xchain) { function f(n){ return f(n+1); } return f(0); };`
    }
];

describe('determinism: resource-termination gasUsed is clamped (fork-safe fee)', function () {
    this.timeout(90000);

    if (!XChainVM) {
        it('REQUIRES isolated-vm (run under the validator Node version)', function () {
            assert.fail('isolated-vm failed to load; cannot verify fee determinism.');
        });
        return;
    }

    for (const v of VECTORS) {
        it(`${v.id}: identical gasUsed across runs`, async function () {
            const RUNS = 10;
            const seen = new Set();
            let lastError = null;
            for (let i = 0; i < RUNS; i++) {
                const vm = createVM();
                if (typeof vm.beginBlock === 'function') vm.beginBlock();
                const r = await execute(vm, v.code, { method: 'default' });
                if (typeof vm.endBlock === 'function') vm.endBlock();
                assert.strictEqual(r.success, false, `${v.id} must fail`);
                assert.match(r.error, v.match, `${v.id} produced unexpected error: ${r.error}`);
                assert.strictEqual(r.gasUsed, 1000000,
                    `${v.id} gasUsed must clamp to the ceiling, got ${r.gasUsed}`);
                lastError = r.error;
                seen.add(r.gasUsed);
            }
            assert.strictEqual(seen.size, 1,
                `NON-DETERMINISTIC gasUsed on "${v.id}": ${seen.size} distinct values ` +
                `${JSON.stringify([...seen])} across ${RUNS} runs (error="${lastError}"). ` +
                `fee = gasUsed * GAS_PRICE → divergent fees → CHAIN FORK. ` +
                `The clamp in src/index.js _classifyError regressed.`);
        });
    }
});
