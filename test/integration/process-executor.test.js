/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Out-of-process executor — the host-abort containment fix.
 *
 * Verifies that subprocess execution: (1) produces results identical to
 * in-process for normal contracts, (2) survives a contract that aborts the
 * V8 host process (the Array(1e8).fill bug) by returning a deterministic
 * resource failure and respawning, (3) carries plain-data snapshots across
 * the IPC boundary.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const XChainVM = require('../../src/index.js');
const { hashResult } = require('../fuzz/harness');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500
};
const LIMITS = {
    maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000,
    maxStateValueSize: 65536, maxCodeSize: 65536, maxStateKeySize: 1024, maxBlockCacheSize: 1000
};
const GAS_CEILING = 1000000;

function makeVM(execution) {
    return new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: GAS_CEILING, limits: LIMITS, execution });
}

const BASE = {
    state: {}, method: 'default', params: [], caller: 'addr',
    contractAddress: 'C:BTC:1', contractIndex: 1,
    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
};

// Probe whether isolated-vm loads at all (skip cleanly if not).
let HAVE_IVM = true;
try { require('isolated-vm'); } catch (e) { HAVE_IVM = false; }

(HAVE_IVM ? describe : describe.skip)('process-executor: out-of-process execution', function () {
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
        // JSON-serialized result) — the same hash the golden manifest uses. This
        // is prototype-agnostic, which is correct: consensus sees the JSON form,
        // not the in-memory object's prototype.
        assert.strictEqual(hashResult(b), hashResult(a),
            'subprocess output must be consensus-identical to in-process');
    });

    it('CONTAINS a host-aborting contract and keeps serving (respawn)', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();

        // This bulk allocation aborts V8 (SIGABRT) in the child ~reliably.
        const bomb = `module.exports = function(xchain){ var a = new Array(100000000).fill('x'); return a.length; };`;
        const r = await vm.execute({ ...BASE, code: bomb });

        assert.strictEqual(r.success, false, 'aborting contract must fail');
        assert.match(r.error, /out_of_resource|out_of_memory|timeout/,
            'host abort must map to a deterministic resource failure, got: ' + r.error);
        assert.strictEqual(r.gasUsed, GAS_CEILING, 'crash must charge the gas ceiling (fork-safe fee)');

        // The executor must have respawned — a normal contract still works.
        const ok = await vm.execute({ ...BASE, code: `module.exports = function(){ return 'alive'; };` });
        assert.strictEqual(ok.success, true, 'executor should serve again after a crash: ' + ok.error);
        assert.strictEqual(ok.returnValue, '"alive"');
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

    it('survives several aborting contracts in a row without leaking', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();
        const bomb = `module.exports = function(){ var a = new Array(100000000).fill('x'); return a.length; };`;
        for (let i = 0; i < 3; i++) {
            const r = await vm.execute({ ...BASE, code: bomb });
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.gasUsed, GAS_CEILING);
        }
        const ok = await vm.execute({ ...BASE, code: `module.exports = function(){ return 1; };` });
        assert.strictEqual(ok.success, true, 'still serving after repeated crashes');
    });
});
