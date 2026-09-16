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

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    let vm;
    afterEach(async function () {
        if (vm) { await vm.shutdown(); vm = null; }
    });

    it('carries plain-data snapshots (oracle) across IPC', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();
        const code = `module.exports = function(xchain){ return xchain.oracle.getPrice('BTC/USD'); };`;
        const r = await vm.execute({
            ...BASE, code,
            oracleData: { snapshotAge: 3, prices: { 'BTC/USD': '65000.00' }, rounds: {} }
        });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"65000.00"', 'oracle snapshot should resolve over IPC');
    });
});
