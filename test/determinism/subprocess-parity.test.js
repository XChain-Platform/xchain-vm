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
 * Subprocess execution: determinism parity + host-abort containment.
 *
 * Production (the indexer) runs the VM in `execution: 'subprocess'` mode so
 * a contract that aborts V8 crashes only the worker, not the host. This guard
 * proves two things the chain depends on:
 *   1. PARITY  — subprocess execution reproduces the EXACT golden-manifest
 *      hashes (byte-identical to in-process; no behavior drift from IPC).
 *   2. CONTAINMENT — the Array(1e8).fill host-abort bug (was Finding A,
 *      2026-06-06) is contained: it returns a deterministic resource failure
 *      (gasUsed = ceiling) and the executor keeps serving.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const XChainVM = require('../../src/index.js');
const { GAS_SCHEDULE, DEFAULT_LIMITS, hashResult, XChainVM: HarnessVM } = require('../fuzz/harness');
const { SCENARIOS, BLOCK } = require('./scenarios');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden-manifest.json'), 'utf8'));
const GAS_CEILING = 1000000;

function makeSubprocessVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING,
        limits: DEFAULT_LIMITS, execution: 'subprocess'
    });
}

(HarnessVM ? describe : describe.skip)('determinism: subprocess parity + host-abort containment', function () {
    this.timeout(120000);

    let vm;
    before(function () { vm = makeSubprocessVM(); vm.beginBlock(); });
    after(async function () { if (vm) { await vm.shutdown(); vm = null; } });

    // Scenarios whose read-only data is plain (no closure accessors) — these
    // serialize across IPC. The oracle-with-price path is covered separately
    // by the executor snapshot test.
    const parityScenarios = SCENARIOS.filter(s =>
        s.tier === 'invariant' && !s.oracleData && !s.crossChainData && !s.contractStakeData);

    for (const sc of parityScenarios) {
        const golden = MANIFEST.scenarios.find(m => m.id === sc.id);
        it(`${sc.id}: subprocess hash == golden manifest`, async function () {
            const r = await vm.execute({
                code: sc.code, method: sc.method, params: sc.params,
                state: sc.state || {}, blockContext: BLOCK, contractIndex: 1
            });
            assert.ok(golden, `manifest missing ${sc.id}`);
            assert.strictEqual(hashResult(r), golden.hash,
                `subprocess result for "${sc.id}" diverged from the golden manifest ` +
                `(gasUsed=${r.gasUsed}, error=${JSON.stringify(r.error)}) — IPC introduced drift.`);
        });
    }

    it('CONTAINMENT: a hostile bulk-allocation contract cannot crash the host', async function () {
        const bomb = `module.exports = function(){ var a = new Array(100000000).fill('x'); return a.length; };`;
        const r = await vm.execute({
            code: bomb, method: 'default', params: [], state: {},
            blockContext: BLOCK, contractIndex: 1
        });
        assert.strictEqual(r.success, false);
        // F3 allocation metering now charges the fill by size → out_of_gas before V8
        // allocates (so it no longer aborts the worker at all). On a path F3 can't
        // wrap it would still be a contained host termination. Either way: a
        // deterministic resource failure at the ceiling.
        assert.match(r.error, /out_of_resource|out_of_memory|timeout|out_of_gas/,
            'must map to a deterministic resource failure, got: ' + r.error);
        assert.strictEqual(r.gasUsed, GAS_CEILING, 'charges the ceiling → fork-safe fee');
        // Still serving after the crash (executor respawned the worker).
        const ok = await vm.execute({
            code: `module.exports = function(){ return 'alive'; };`,
            method: 'default', params: [], state: {}, blockContext: BLOCK, contractIndex: 1
        });
        assert.strictEqual(ok.success, true, 'executor must serve again after a crash: ' + ok.error);
    });
});
