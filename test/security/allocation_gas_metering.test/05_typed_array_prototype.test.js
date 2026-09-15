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
 * Allocation-size gas metering (F3)
 *
 * The AST meter charges a flat __gas(1) per call, so a bulk-allocation builtin
 * (new Array(1e8).fill, 'x'.repeat(1e9), Array.from({length:1e8})) cost ~2 gas
 * while V8 materialized hundreds of MB. On x86 the worker then churned ~28s to
 * the wall-clock timeout (a cheap liveness-degradation; the backstop that fired
 * was arch/timing-dependent). The harness now wraps these builtins at the
 * PROTOTYPE level to charge __gas(size) BEFORE delegating, so the deterministic
 * gas ceiling rejects the allocation first. Defense-in-depth: the out-of-process
 * executor remains the load-bearing containment for paths that can't be wrapped.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const CEILING = 1000000;


// Compute-size gas metering: TypedArray prototype O(n) methods (G1-TA)
//
// The G1 block meters the O(n) Array.prototype/String.prototype methods, but
// TypedArrays (Uint8Array, Float64Array, ...) do NOT inherit Array.prototype:
// their sort/reverse/copyWithin/indexOf/set/... are the native
// %TypedArray%.prototype versions and were left uncharged by both G1 (Array/
// String only) and F3-binary (which meters only the CONSTRUCTORS, i.e. the
// one-time backing-store allocation). Unmetered, a contract could `new
// Uint8Array(n)` once (charged once) then loop t.sort()/t.reverse()/
// t.copyWithin(0,1) for ~2 gas per O(n)/O(n log n) native pass: the cheap-gas/
// expensive-CPU grind + timeout-vs-commit fork surface that G1 exists to close.
// The harness now wraps the shared %TypedArray% prototype with the identical
// __meterLen / default-sort cost model. Gated on the SAME block-time flag-day as
// F3-binary (XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME): below it the methods stay
// unmetered (pre-activation replay preserved), above it every node charges the
// O(n)/O(n log n) work so the deterministic gas ceiling binds before the wall-
// clock net can diverge across a heterogeneous fleet.

(XChainVM ? describe : describe.skip)('compute-size gas metering: TypedArray prototype (G1-TA)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // A large Uint8Array, allocated identically in the baseline and the op so the
    // gas DELTA isolates the prototype-method cost (the constructor's byte charge,
    // itself active above the gate, cancels out). N gas << the 1e6 ceiling.
    const N = 200000;
    const TA_BUILD = `var t = new Uint8Array(${N});`;
    const taBase = `module.exports=function(){ ${TA_BUILD} return t.length; };`;
    const taOp = (call) => `module.exports=function(){ ${TA_BUILD} ${call}; return t.length; };`;

    // Each O(n) scan/copy/in-place method must add ~N gas for the native pass.
    [['reverse', 't.reverse()'],
     ['indexOf', 't.indexOf(255)'],       // all-zero array → full O(n) scan, not found
     ['copyWithin', 't.copyWithin(0,1)'],
     ['fill', 't.fill(7)'],
     ['slice', 't.slice()']].forEach(function (mc) {
        it(`${mc[0]} is charged by element length above the gate`, async function () {
            const base = await above(taBase);
            const op = await above(taOp(mc[1]));
            assert.strictEqual(base.success, true, base.error);
            assert.strictEqual(op.success, true, op.error);
            const delta = op.gasUsed - base.gasUsed;
            assert.ok(delta >= N * 0.5,
                `TypedArray.${mc[0]} must add ~${N} gas for the O(n) native work, got delta ${delta}`);
        });
    });

    it('reverse adds ~0 gas below the gate (historical replay preserved)', async function () {
        const base = await below(taBase);
        const op = await below(taOp('t.reverse()'));
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        const delta = op.gasUsed - base.gasUsed;
        assert.ok(delta < 1000,
            `pre-gate TypedArray.reverse must stay unmetered (legacy), got delta ${delta}`);
    });

});

(XChainVM ? describe : describe.skip)('compute-size gas metering: TypedArray prototype (G1-TA)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const N = 200000;

    it('set(src) is charged by the source length above the gate', async function () {
        // dst.set(src) copies src.length elements into dst's existing store (no alloc).
        const setBase = `module.exports=function(){ var d=new Uint8Array(${N}); var s=new Uint8Array(${N}); return d.length+s.length; };`;
        const setOp = `module.exports=function(){ var d=new Uint8Array(${N}); var s=new Uint8Array(${N}); d.set(s); return d.length; };`;
        const base = await above(setBase);
        const op = await above(setOp);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= N * 0.5,
            `TypedArray.set must add ~${N} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

});

(XChainVM ? describe : describe.skip)('compute-size gas metering: TypedArray prototype (G1-TA)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- default-comparator sort: n*ceil(log2 n) native NUMERIC compares ----
    const S = 10000; // ceil(log2 10000) = 14 → ~140k compare gas; alloc = 40k bytes
    const SORT_BUILD = `var a=new Int32Array(${S}); for(var i=0;i<${S};i++) a[i]=(i*7919)%${S};`;
    const sortBase = `module.exports=function(){ ${SORT_BUILD} return a.length; };`;

    it('default sort() is charged ~n*log2(n) above the gate', async function () {
        const base = await above(sortBase);
        const op = await above(`module.exports=function(){ ${SORT_BUILD} a.sort(); return a[0]; };`);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= S * 10,
            `TypedArray default sort must add ~${S * 14} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('default sort() adds ~0 gas below the gate (historical replay preserved)', async function () {
        const base = await below(sortBase);
        const op = await below(`module.exports=function(){ ${SORT_BUILD} a.sort(); return a[0]; };`);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed < 1000,
            `pre-gate TypedArray sort must stay unmetered (legacy), got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('a USER-comparator sort adds the O(n) base charge above the gate, ~0 below (replay preserved)', async function () {
        // Unlike Array (whose O(n) base charge is legacy/pre-gate, so its comparator sort
        // reads identically across the gate), TypedArray methods were entirely UNMETERED
        // before this upgrade, so the whole metering block is gated. A user comparator runs
        // metered contract code per compare on BOTH sides (that portion is unaffected by the
        // gate), so the only cross-gate difference is the newly-added O(n) permutation base:
        // above the gate it charges ~n, below the gate it stays unmetered (~0 delta), keeping
        // historical replay bit-identical. Charging n below the gate would break that replay.
        const CMP = `module.exports=function(){ ${SORT_BUILD} a.sort(function(x,y){ return x-y; }); return a[0]; };`;
        const lo = await below(CMP);
        const hi = await above(CMP);
        assert.strictEqual(lo.success, true, lo.error);
        assert.strictEqual(hi.success, true, hi.error);
        assert.strictEqual(hi.returnValue, lo.returnValue);
        assert.ok(hi.gasUsed - lo.gasUsed >= S * 0.5,
            `above-gate comparator sort must add the ~${S} O(n) base charge, got delta ${hi.gasUsed - lo.gasUsed}`);
    });

});

(XChainVM ? describe : describe.skip)('compute-size gas metering: TypedArray prototype (G1-TA)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const N = 200000;
    const TA_BUILD = `var t = new Uint8Array(${N});`;
    const taBase = `module.exports=function(){ ${TA_BUILD} return t.length; };`;
    const taOp = (call) => `module.exports=function(){ ${TA_BUILD} ${call}; return t.length; };`;

    it('the reverse/copyWithin grind is gas-bounded above the gate (no wall-clock stall)', async function () {
        const t0 = Date.now();
        const r = await above(`module.exports=function(){
            var t=new Uint8Array(50000); var sink=0;
            for(var i=0;i<100000;i++){ t.reverse(); t.copyWithin(0,1); sink+=t[0]; }
            return sink; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'the TypedArray grind must be gas-bounded, got: ' + r.error);
        assert.ok(Date.now() - t0 < 3000,
            'must fail fast on gas, not grind to the wall-clock net (got ' + (Date.now() - t0) + 'ms)');
    });

    it('subarray() is NOT length-charged above the gate (O(1) view, no copy)', async function () {
        // subarray returns a view over the SAME buffer (no allocation, no O(n) copy),
        // so metering it by length would over-bill work that never runs. Assert the
        // method adds ~0 gas even above the gate.
        const base = await above(taBase);
        const op = await above(taOp('var v = t.subarray(0, 100000)'));
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed < 1000,
            `subarray must stay O(1) (not length-charged), got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('legitimate small TypedArray ops stay cheap and correct above the gate', async function () {
        const r = await above(`module.exports=function(){
            var t=new Uint8Array([3,1,2]); t.sort(); t.reverse();
            return [t[0], t[1], t[2]]; };`);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(JSON.parse(r.returnValue), [3, 2, 1]);
        assert.ok(r.gasUsed < 1000, 'small TypedArray ops must not be over-charged, got ' + r.gasUsed);
    });
});
