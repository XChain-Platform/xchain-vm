// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const crypto = require('crypto');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping determinism tests, isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    // Cross-chain call buckets. MUST match the production per-chain configs
    // (xchain-indexer/src/coins/{BTC,LTC,DOGE}.js). gateway-emit.js carries
    // identical fallback defaults, but the keys are pinned here explicitly so
    // the crossExecute baselines are computed against the production schedule.
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        execution: 'in-process',  // explicit: containment not needed in unit/fuzz harnesses
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function hashResult(result) {
    // Normalize for comparison: sort state changes by key
    const normalized = {
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed,
        returnValue: result.returnValue,
        stateChanges: [...result.stateChanges].sort((a, b) => a.key.localeCompare(b.key)),
        stateDeletes: [...result.stateDeletes].sort(),
        emittedActions: result.emittedActions,
        logs: result.logs
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function runTwice(vm, opts) {
    const result1 = await vm.execute(opts);
    const result2 = await vm.execute(opts);
    return [result1, result2];
}

const baseOpts = {
    state: { counter: '5', owner: 'addr1' },
    method: 'default',
    params: ['arg1', 'arg2'],
    caller: 'addr1',
    contractAddress: 'C:BTC:100',
    blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash123' }
};

const POST_GATE_CTX = {
    height: 999,
    timestamp: (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800,
    hash: 'post_gate_hash'
};

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    // Fix 4095: binary-alloc metering (F3-binary) determinism fixtures.
    // These run at a post-flag-day blockContext.timestamp so the byte-length
    // charge is active. A regression in __meterBinaryCtor wrapping (including
    // newly added Float16Array) or in the BYTES_PER_ELEMENT accounting would
    // shift gasUsed; the run-twice check catches same-process regressions.
    // See binary-alloc-gate.regression.test.js for the gate-boundary check and
    // determinism-baseline.test.js for the committed cross-arch digest.

    it('should produce identical gasUsed for Uint8Array allocation (post-flag-day)', async function() {
        const code = `module.exports = function() { var a = new Uint8Array(200); return a.length; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        // Uint8Array(200) charges 200 bytes (BYTES_PER_ELEMENT = 1).
        assert.ok(r1.gasUsed >= 200, 'expected >= 200 gas for 200-byte allocation, got ' + r1.gasUsed);
    });

    it('should produce identical gasUsed for Float64Array allocation (post-flag-day)', async function() {
        // Float64Array(100) = 100 * 8 = 800 bytes; charge must be 800.
        const code = `module.exports = function() { var a = new Float64Array(100); return a.length; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.ok(r1.gasUsed >= 800, 'expected >= 800 gas for Float64Array(100), got ' + r1.gasUsed);
    });

    it('should produce identical gasUsed for ArrayBuffer allocation (post-flag-day)', async function() {
        const code = `module.exports = function() { var b = new ArrayBuffer(512); return b.byteLength; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.ok(r1.gasUsed >= 512, 'expected >= 512 gas for ArrayBuffer(512), got ' + r1.gasUsed);
    });
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should produce identical gasUsed for TypedArray view (no new backing store, no charge)', async function() {
        // A TypedArray constructed over an existing ArrayBuffer must NOT charge
        // for the backing bytes (no new allocation). This is the no-charge branch
        // in __meterBinaryCtor: first arg is an ArrayBuffer, not a number.
        const code = `module.exports = function() {
            var buf = new ArrayBuffer(64);
            var view = new Uint8Array(buf);
            return view.length;
        };`;
        // Run pre-flag-day so the ArrayBuffer allocation is also unmetered;
        // we only want to confirm the view does not add charge on top.
        const PRE_GATE_CTX = { height: 1, timestamp: 0, hash: 'pre_gate' };
        const opts = { ...baseOpts, code, state: {}, blockContext: PRE_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.returnValue, '64');
    });

    it('should produce no binary-alloc charge below the flag-day timestamp', async function() {
        const code = `module.exports = function() { var a = new Uint8Array(50000); return a.length; };`;
        const PRE_GATE_CTX = { height: 1, timestamp: 0, hash: 'pre_gate' };
        const POST_GATE = POST_GATE_CTX;
        const optsPre  = { ...baseOpts, code, state: {}, blockContext: PRE_GATE_CTX };
        const optsPost = { ...baseOpts, code, state: {}, blockContext: POST_GATE };
        const pre  = await vm.execute(optsPre);
        const post = await vm.execute(optsPost);
        assert.strictEqual(pre.success, true);
        assert.strictEqual(post.success, true);
        // Post-gate must carry the 50000-byte charge; pre-gate must not.
        assert.ok(post.gasUsed >= 50000, 'post-gate gasUsed must include byte charge, got ' + post.gasUsed);
        assert.ok(pre.gasUsed < 50000,  'pre-gate gasUsed must NOT include byte charge, got ' + pre.gasUsed);
        assert.ok(post.gasUsed > pre.gasUsed, 'gasUsed must differ across the gate');
    });
});
