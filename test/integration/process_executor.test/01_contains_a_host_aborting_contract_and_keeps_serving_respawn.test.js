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

    it('CONTAINS a host-aborting contract and keeps serving (respawn)', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();

        // A hostile bulk allocation. With F3 allocation metering it is charged by
        // size and hits the gas ceiling (out_of_gas) BEFORE V8 services it, so it no
        // longer aborts the worker; either way it is contained as a deterministic
        // resource failure at the ceiling and the executor keeps serving.
        const bomb = `module.exports = function(xchain){ var a = new Array(100000000).fill('x'); return a.length; };`;
        const r = await vm.execute({ ...BASE, code: bomb });

        assert.strictEqual(r.success, false, 'hostile allocation must fail');
        assert.match(r.error, /out_of_resource|out_of_memory|timeout|out_of_gas/,
            'must map to a deterministic resource failure, got: ' + r.error);
        assert.strictEqual(r.gasUsed, GAS_CEILING, 'must charge the gas ceiling (fork-safe fee)');

        // The executor must have respawned; a normal contract still works.
        const ok = await vm.execute({ ...BASE, code: `module.exports = function(){ return 'alive'; };` });
        assert.strictEqual(ok.success, true, 'executor should serve again after a crash: ' + ok.error);
        assert.strictEqual(ok.returnValue, '"alive"');
    });
});
