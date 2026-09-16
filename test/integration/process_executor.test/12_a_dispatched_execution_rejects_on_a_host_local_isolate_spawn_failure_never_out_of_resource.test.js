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
 * Out-of-process executor: the host-abort containment fix.
 *
 * Verifies that subprocess execution: (1) produces results identical to
 * in-process for normal contracts, (2) survives a contract that aborts the
 * V8 host process (the Array(1e8).fill bug) by returning a deterministic
 * resource failure and respawning, (3) carries plain-data snapshots across
 * the IPC boundary.
 ********************************************************************/
// @ts-nocheck


const { assert, hashResult, GAS_SCHEDULE, LIMITS, GAS_CEILING, makeVM, BASE, HAVE_IVM } = require('./support/executor_setup.js');

    // The DISPATCHED half of the halt-vs-fabricate rule, end to end through the
    // real worker. index.js raises HostFaultError when createIsolate() fails on
    // THIS host (memory pressure, thread-creation failure) and classifyError
    // re-throws it precisely so no verdict is written. Swallowing that into
    // process.exit(1) makes onExit commit
    // 'out_of_resource: execution host terminated' at gasUsed = ceiling for an
    // execution every healthy peer commits as a success -- a unilateral fork.
    //
    // maxMemory below isolated-vm's 8 MB floor makes `new ivm.Isolate` throw for
    // real, so the whole production path runs: isolate.js -> index.js:2192
    // HostFaultError -> classifyError re-throw -> the worker's catch. Nothing is
    // stubbed, so a regression on either side of the IPC seam reddens this.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('a dispatched execution REJECTS on a host-local isolate-spawn failure (never out_of_resource)', async function () {
        const ProcessExecutor = require('../../../src/process_executor.js');
        const { HostFaultError } = require('../../../src/errors.js');
        const exec = new ProcessExecutor({
            gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING,
            limits: { ...LIMITS, maxMemory: 1 }
        });
        exec.beginBlock();
        try {
            const p = exec.execute({ ...BASE, code: `module.exports = function(){ return 1; };` });
            let settled = null;
            await p.then((r) => { settled = { resolved: r }; }, (e) => { settled = { rejected: e }; });

            assert.ok(!settled.resolved,
                'a host-local fault must not resolve a contract outcome, got: ' +
                JSON.stringify(settled.resolved));
            const e = settled.rejected;
            assert.ok(e instanceof HostFaultError && e.code === 'EXECUTOR_UNAVAILABLE',
                'must reject with HostFaultError so the indexer halts and retries, got: ' + e);
            assert.match(e.message, /isolate unavailable/,
                'the reason string must survive the IPC hop for incident diagnosis: ' + e.message);

            // The worker never ran a contract, so it must still be alive and
            // dispatchable: no respawn, no spawn-failure accounting, no broken latch.
            assert.ok(exec._child && exec._child.connected, 'the worker must not have been killed');
            assert.strictEqual(exec._broken, false, 'a per-execution host fault is not the broken latch');
            assert.strictEqual(exec._consecutiveSpawnFailures, 0, 'the worker started fine; nothing to count');
            assert.strictEqual(exec._pending.size, 0, 'the in-flight slot must be released');
        } finally {
            await exec.shutdown();
        }
    });
});
