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
 * Acceptance test: gas-vs-wall-clock is a host-timing
 * race, so the consensus-visible result of a gas-burning contract MUST be
 * identical whether the gas ceiling or the wall-clock net fires first.
 *
 * A tight loop races two ceilings: the gas ceiling (deterministic, fixed
 * iteration count) and the wall-clock safety net (host-speed/-load
 * dependent). On a fast validator gas wins (VM error "out_of_gas: ..."); on
 * a slow/loaded one the wall-clock net wins ("timeout: ..."). The indexer
 * hashes the status_id derived from that error into contract_hash
 * (xchain-indexer util.vmFailureStatus → db.getBlockHashes), so two honest
 * validators committing different tokens would FORK.
 *
 * The determinism harness once hashed the raw error, and the indexer kept
 * `out_of_gas` distinct from `out_of_resource`, so the two budgets below
 * produced different consensus results. The resource-exhaustion family
 * (out_of_gas / timeout / out_of_memory /
 * out_of_stack / out_of_resource) collapses to one host-independent token
 * (harness `consensusError`, mirroring the indexer collapse), so WHICH
 * ceiling fires no longer changes consensus. gasUsed is clamped to the
 * ceiling on both paths, so the fee was already fork-safe.
 *
 * The race exists only below the consensus wall-clock gate, so the runs pin
 * a pre-gate block and assert their per-node budgets. The suite also asserts
 * the two runs took different ceilings; a host that cannot produce both
 * reports pending rather than passing on a race it never ran.
 *
 * Run this acceptance tier with:
 *     npm run test:known-red
 *
 * Evidence behind it: test/determinism/helpers/probe_gas_vs_wallclock_race.js.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createVM, execute, hashResult, consensusError } = require('../fuzz/helpers/harness.js');

// A pure gas-burning loop: while(true){} with __gas(1) per iteration.
const LOOP = fs.readFileSync(path.join(__dirname, '../fixtures/contracts/infinite_loop.js'), 'utf8');

// Pin a block below the consensus wall-clock gate (no network, pre-gate time):
// above it every node gets the same fixed budget and the race cannot occur.
const PRE_GATE_BLOCK = { height: 100, timestamp: 1700000000, hash: 'abc123' };

async function run(maxCpuTimeMs) {
    const vm = createVM({ maxCpuTimeMs }); // gas ceiling stays at the 1,000,000 default
    const budgetMs = vm.wallClockBudgetMs({ blockContext: PRE_GATE_BLOCK });
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, LOOP, {
        method: 'default', params: [], state: {}, contractIndex: 1, blockContext: PRE_GATE_BLOCK
    });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return { r, budgetMs };
}

// Classify which ceilings the two runs took: 'race', 'host-limited' or 'mismatch'.
function raceOutcome(fastError, slowError) {
    const gas = (e) => /^out_of_gas\b/.test(String(e));
    const clock = (e) => /^timeout\b/.test(String(e));
    if (gas(fastError) && clock(slowError)) return 'race';
    if ((gas(fastError) && gas(slowError)) || (clock(fastError) && clock(slowError))) return 'host-limited';
    return 'mismatch';
}

describe('gas-vs-wall-clock status must not fork', function () {
    this.timeout(60000);

    let fast, slow, fastBudgetMs, slowBudgetMs;
    before(async function () {
        // FAST validator: generous budget → the gas ceiling wins (out_of_gas).
        ({ r: fast, budgetMs: fastBudgetMs } = await run(5000));
        // SLOW/loaded validator: tight budget (host-speed proxy) → the
        // wall-clock net wins (timeout). A host N× slower trips a 5000 ms net
        // at the same gasUsed a fast host trips a 5000/N ms net at.
        ({ r: slow, budgetMs: slowBudgetMs } = await run(1));
    });

    it('each run gets its own per-node wall-clock budget (pre-gate regime)', function () {
        assert.strictEqual(fastBudgetMs, 5000,
            `fast run budget is ${fastBudgetMs} ms, not 5000: the consensus wall-clock gate is active for this block`);
        assert.strictEqual(slowBudgetMs, 1,
            `slow run budget is ${slowBudgetMs} ms, not 1: the consensus wall-clock gate is active, so the slow run cannot take the timeout path`);
    });

    it('both runs terminate in the resource-exhaustion family', function () {
        assert.strictEqual(fast.success, false, `fast run should fail: ${JSON.stringify(fast.error)}`);
        assert.strictEqual(slow.success, false, `slow run should fail: ${JSON.stringify(slow.error)}`);
    });

    it('the two runs took different ceilings (the race was exercised)', function () {
        const outcome = raceOutcome(fast.error, slow.error);
        if (outcome === 'race') return;
        const raw = `fast=${JSON.stringify(fast.error)} slow=${JSON.stringify(slow.error)}`;
        if (outcome === 'host-limited') {
            // Report pending, not passing: the consensus checks below would hold trivially.
            console.warn(`gas-vs-wall-clock race not exercised on this host (${raw}); skipping`);
            this.skip();
        }
        assert.fail(`expected fast=out_of_gas and slow=timeout, got ${raw}`);
    });

    it('gasUsed is clamped to the ceiling on both paths (fee is fork-safe)', function () {
        assert.strictEqual(fast.gasUsed, slow.gasUsed,
            `gasUsed diverged (fee fork): fast=${fast.gasUsed} slow=${slow.gasUsed}`);
    });

    it('the consensus status token is identical across host speeds (no fork)', function () {
        const fStatus = consensusError(fast.error);
        const sStatus = consensusError(slow.error);
        assert.strictEqual(fStatus, sStatus,
            `CONSENSUS STATUS FORK: fast=${JSON.stringify(fStatus)} (raw ${JSON.stringify(fast.error)}) ` +
            `vs slow=${JSON.stringify(sStatus)} (raw ${JSON.stringify(slow.error)}). ` +
            `Which ceiling fires must not change the hashed status_id.`);
        assert.strictEqual(fStatus, 'out_of_resource',
            `resource exhaustion must collapse to the host-independent token, got ${JSON.stringify(fStatus)}`);
    });

    it('the full consensus-projected result hash is identical across host speeds', function () {
        // The determinism guard hashes this projection; equal hash here means a
        // validator at either host speed commits the identical contract_hash.
        assert.strictEqual(hashResult(fast), hashResult(slow),
            'DETERMINISM BREAK: the gas-vs-wall-clock race changed the consensus-visible result hash.');
    });
});
