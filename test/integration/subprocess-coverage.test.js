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
 * XChain VM: Subprocess coverage harness.
 *
 * The isolate-execution code that runs ONLY inside the forked worker
 * (src/vm-worker.js message handlers, plus src/sandbox.js stripGlobals and
 * the in-isolate paths of src/index.js execute) is invisible to a parent-only
 * coverage run: the child is a separate process. c8 already sets
 * NODE_V8_COVERAGE and merges any coverage-*.json a child writes into that
 * directory, but the parent SIGKILLs the worker on shutdown/respawn and
 * SIGKILL cannot flush V8 coverage, so the worker's execute path was lost
 * (it raced the kill). src/vm-worker.js now calls v8.takeCoverage() after
 * each execute/endBlock (guarded on NODE_V8_COVERAGE, inert in production),
 * which writes the worker's profile deterministically before any kill.
 *
 * This harness drives a full worker lifecycle (init -> beginBlock -> several
 * executes exercising sandbox + gateway paths -> endBlock) so the worker's
 * coverage is written and, under `npm run coverage:subprocess`, the three
 * isolate-execution files appear in the merged report. Run it on Node 22 /
 * Linux (isolated-vm cannot dlopen on macOS); it skips cleanly otherwise.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const XChainVM = require('../../src/index.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const LIMITS = {
    maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000,
    maxStateValueSize: 65536, maxCodeSize: 65536, maxStateKeySize: 1024, maxBlockCacheSize: 1000
};
const GAS_CEILING = 1000000;

const BASE = {
    state: {}, method: 'default', params: [], caller: 'addr',
    contractAddress: 'C:BTC:1', contractIndex: 1,
    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
};

// Probe whether isolated-vm loads at all (skip cleanly if not, e.g. macOS).
let HAVE_IVM = true;
try { require('isolated-vm'); } catch (e) { HAVE_IVM = false; }

(HAVE_IVM ? describe : describe.skip)('subprocess coverage harness: worker isolate-execution paths', function () {
    this.timeout(60000);

    let vm;
    afterEach(async function () {
        if (vm) { await vm.shutdown(); vm = null; }
    });

    it('drives a full worker lifecycle so the child flushes its coverage', async function () {
        vm = new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS, execution: 'subprocess' });
        vm.beginBlock();

        // Exercise the worker execute handler and, through it, sandbox.stripGlobals
        // and a spread of in-isolate gateway paths (state, math, emit, oracle, log).
        const code = `module.exports = function(xchain){
            xchain.log('start');
            xchain.state.set('n', xchain.math.add(xchain.state.get('n') || '0', '5'));
            if (xchain.state.has('n')) {
                xchain.emit.send({ destination: 'D', tick: 'TEST', quantity: xchain.state.get('n') });
            }
            var p = xchain.oracle.getPrice('BTC/USD');
            xchain.state.delete('scratch');
            return p;
        };`;
        const r = await vm.execute({
            ...BASE, code, state: { n: '37', scratch: '1' },
            oracleData: { snapshotAge: 3, prices: { 'BTC/USD': '65000.00' }, rounds: {} }
        });
        assert.strictEqual(r.success, true, 'lifecycle execute should succeed: ' + r.error);
        assert.strictEqual(r.returnValue, '"65000.00"');

        // A second execute on the same live worker (warm path: metered-source and
        // compilation caches are hit inside the child).
        const r2 = await vm.execute({ ...BASE, code, state: { n: '1' },
            oracleData: { snapshotAge: 1, prices: { 'BTC/USD': '1.00' }, rounds: {} } });
        assert.strictEqual(r2.success, true, 'warm execute should succeed: ' + r2.error);

        // endBlock reaches the worker's endBlock handler and flushes coverage.
        // Open a fresh block and run one more execute AFTER endBlock: the worker
        // processes messages on a single sequential chain, so awaiting this
        // execute proves the prior endBlock callback ran (and flushed) inside the
        // child rather than racing shutdown's SIGKILL.
        vm.endBlock();
        vm.beginBlock();
        const r3 = await vm.execute({ ...BASE,
            code: `module.exports = function(){ return 'block2'; };` });
        assert.strictEqual(r3.success, true, 'execute after endBlock should succeed: ' + r3.error);
        assert.strictEqual(r3.returnValue, '"block2"');
        vm.endBlock();
    });

    it('covers the worker revert/failure path (still a normal worker result)', async function () {
        vm = new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS, execution: 'subprocess' });
        vm.beginBlock();
        const code = `module.exports = function(xchain){ xchain.require(false, 'nope'); return 1; };`;
        const r = await vm.execute({ ...BASE, code });
        assert.strictEqual(r.success, false, 'require(false) must revert');
        assert.match(r.error, /revert/, 'error should be a revert: ' + r.error);
        vm.endBlock();
    });
});
