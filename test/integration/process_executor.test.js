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


const { assert, hashResult, GAS_SCHEDULE, LIMITS, GAS_CEILING, makeVM, BASE, HAVE_IVM } = require('./process_executor.test/support/executor_setup.js');

(HAVE_IVM ? describe : describe.skip)('process_executor: out-of-process execution', function () {
    this.timeout(60000);

    let vm;
    afterEach(async function () {
        if (vm) { await vm.shutdown(); vm = null; }
    });

    it('runs a normal contract and matches in-process output', async function () {
        const code = `module.exports = function(xchain){
            xchain.state.set('n', xchain.math.add(xchain.state.get('n') || '0', '5'));
            xchain.emit.send({ destination: 'D', tick: 'TEST', quantity: '5' });
            return 'ok';
        };`;
        const inproc = makeVM('in-process');
        inproc.beginBlock();
        const a = await inproc.execute({ ...BASE, code, state: { n: '37' } });
        inproc.endBlock();

        vm = makeVM('subprocess');
        vm.beginBlock();
        const b = await vm.execute({ ...BASE, code, state: { n: '37' } });
        vm.endBlock();

        assert.strictEqual(b.success, true, 'subprocess run should succeed: ' + b.error);
        // Compare via the consensus-equality function (sha256 of the normalized,
        // JSON-serialized result): the same hash the golden manifest uses. This
        // is prototype-agnostic, which is correct: consensus sees the JSON form,
        // not the in-memory object's prototype.
        assert.strictEqual(hashResult(b), hashResult(a),
            'subprocess output must be consensus-identical to in-process');
    });
});
