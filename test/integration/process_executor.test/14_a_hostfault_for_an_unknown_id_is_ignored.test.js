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

    // A hostfault message naming an id the parent has already settled (watchdog
    // fired first, or the worker died in the same tick) must be a no-op, never a
    // second settle on a resolved promise.
(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    it('a hostfault for an unknown id is ignored', function () {
        const ProcessExecutor = require('../../../src/process-executor.js');
        const exec = new ProcessExecutor({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS });
        try {
            exec.onMessage({ type: 'hostfault', id: 999999, reason: 'stale' });
            assert.strictEqual(exec._pending.size, 0);
        } finally {
            exec.shutdown();
        }
    });
});
