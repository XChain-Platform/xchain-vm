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


// Additive O(n)-copy metering upgrades, all gated on the same block-time flag-day
// as F3-binary (XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME). Each closes an O(n)-work-
// for-O(1)-gas hole in the sandbox that the earlier wrappers missed:
//   #128  Array.from / TypedArray over a Set/Map/generator (no numeric .length)
//   #127  Array.prototype.flat() charged by outer length, not flattened size
//   #129  spread into call/new/method arguments (f(...x), new C(...x), push(...x))
//   #220  the F-NR native-depth guard charged O(1)/node while scanning O(width)
// Below the gate every one replays the legacy (under-)charge byte-for-bit; above it
// the O(n) work is billed so the deterministic gas ceiling binds before the CPU-time
// wall-clock net can diverge across a heterogeneous validator fleet.

(XChainVM ? describe : describe.skip)('O(n)-copy metering upgrades (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #128: Array.from / TypedArray over iterable (Set/Map/generator) sources ----
    const N = 20000;
    // Build an N-element Set once, then optionally copy it. Delta isolates the copy.
    const SET_BUILD = `var s=new Set(); for(var i=0;i<${N};i++) s.add(i);`;
    const setBase = `module.exports=function(){ ${SET_BUILD} return s.size; };`;
    const setFrom = `module.exports=function(){ ${SET_BUILD} var a=Array.from(s); return a.length; };`;
    // .values() is a bare iterator: no .length, no .size (the generator-shaped path).
    const setIter = `module.exports=function(){ ${SET_BUILD} var a=Array.from(s.values()); return a.length; };`;

    it('#128 Array.from(Set) is charged by size above the gate', async function () {
        const base = await above(setBase);
        const op = await above(setFrom);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= N * 0.5,
            `Array.from(Set) must add ~${N} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#128 Array.from(Set) adds ~0 gas below the gate (historical replay preserved)', async function () {
        const base = await below(setBase);
        const op = await below(setFrom);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed < 1000,
            `pre-gate Array.from(Set) must stay unmetered (legacy), got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#128 Array.from(bare iterator) is charged by materialized length above the gate', async function () {
        const base = await above(setBase);
        const op = await above(setIter);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= N * 0.5,
            `Array.from(iterator) must add ~${N} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#128 new Uint8Array(Set) is charged by size above the gate (TypedArray sibling)', async function () {
        const base = await above(setBase);
        const op = await above(`module.exports=function(){ ${SET_BUILD} var a=new Uint8Array(s); return a.length; };`);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= N * 0.5,
            `new Uint8Array(Set) must add ~${N} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

});

(XChainVM ? describe : describe.skip)('O(n)-copy metering upgrades (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #127: Array.prototype.flat() charged by flattened result length ----
    const M = 100000;
    const FLAT_BUILD = `var inner=new Array(${M}).fill(0);`;
    it('#127 [bigInner].flat() is charged by flattened length above the gate', async function () {
        const base = await above(`module.exports=function(){ ${FLAT_BUILD} return inner.length; };`);
        const op = await above(`module.exports=function(){ ${FLAT_BUILD} var r=[inner].flat(); return r.length; };`);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= M * 0.5,
            `[bigInner].flat() must add ~${M} gas (flattened size) above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#127 [bigInner].flat() adds ~0 gas below the gate (legacy outer-length charge)', async function () {
        const base = await below(`module.exports=function(){ ${FLAT_BUILD} return inner.length; };`);
        const op = await below(`module.exports=function(){ ${FLAT_BUILD} var r=[inner].flat(); return r.length; };`);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed < 1000,
            `pre-gate flat() must charge only outer length (~0 here), got delta ${op.gasUsed - base.gasUsed}`);
    });

});

(XChainVM ? describe : describe.skip)('O(n)-copy metering upgrades (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #129: spread into call / new / method arguments ----
    it('#129 a loop of f(...bigArray) is gas-bounded above the gate (no wall-clock stall)', async function () {
        const t0 = Date.now();
        const r = await above(`module.exports=function(){
            var a=new Array(3000).fill(0); var f=function(){return arguments.length;}; var sink=0;
            for(var i=0;i<2000;i++){ sink+=f(...a); } return sink; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'call-spread must be gas-bounded above the gate, got: ' + r.error);
        assert.ok(Date.now() - t0 < 3000, 'must fail fast on gas (got ' + (Date.now() - t0) + 'ms)');
    });

    it('#129 the same loop succeeds cheaply below the gate (historical replay preserved)', async function () {
        const r = await below(`module.exports=function(){
            var a=new Array(3000).fill(0); var f=function(){return arguments.length;}; var sink=0;
            for(var i=0;i<2000;i++){ sink+=f(...a); } return sink; };`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, String(2000 * 3000));
    });

    it('#129 argument-spread semantics are preserved above the gate', async function () {
        const call = await above(`module.exports=function(){
            var a=[1,2,3]; function sum(){var s=0;for(var i=0;i<arguments.length;i++)s+=arguments[i];return s;}
            return sum(...a, 4); };`);
        assert.strictEqual(call.success, true, call.error);
        assert.strictEqual(call.returnValue, '10');

        const ctor = await above(`module.exports=function(){
            function C(x,y){this.s=x+y;} var a=[2,3]; return new C(...a).s; };`);
        assert.strictEqual(ctor.success, true, ctor.error);
        assert.strictEqual(ctor.returnValue, '5');

        const push = await above(`module.exports=function(){
            var arr=[1]; var x=[2,3]; arr.push(...x); return arr.length; };`);
        assert.strictEqual(push.success, true, push.error);
        assert.strictEqual(push.returnValue, '3');
    });

});

(XChainVM ? describe : describe.skip)('O(n)-copy metering upgrades (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #220: F-NR native-depth guard charges scan width, not O(1)/node ----
    it('#220 reference-reused wide array join() is gas-bounded above the gate', async function () {
        const t0 = Date.now();
        const r = await above(`module.exports=function(){
            var a=new Array(2000).fill(0); var r=[];
            for(var i=0;i<2000;i++){ r.push(a); }
            return r.join(',').length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'reference-reused wide-array scan must be gas-bounded, got: ' + r.error);
        assert.ok(Date.now() - t0 < 3000, 'must fail fast on gas (got ' + (Date.now() - t0) + 'ms)');
    });

    it('#220 a legitimate small nested join succeeds both sides; the guard adds width gas above the gate', async function () {
        // Small enough to complete below the gate (legacy nested-toString charge only)
        // AND above it (guard width charge added). Proves the guard does not break
        // legitimate nested joins and that its width charge is the only new cost.
        const SMALL = `module.exports=function(){
            var a=new Array(100).fill(0); var r=[];
            for(var i=0;i<100;i++){ r.push(a); }
            return r.join(',').length; };`;
        const lo = await below(SMALL);
        const hi = await above(SMALL);
        assert.strictEqual(lo.success, true, 'legacy small nested join must complete: ' + lo.error);
        assert.strictEqual(hi.success, true, 'above-gate small nested join must complete: ' + hi.error);
        assert.strictEqual(hi.returnValue, lo.returnValue, 'the join result is identical across the gate');
        assert.ok(hi.gasUsed > lo.gasUsed,
            `above the gate the F-NR guard adds width gas (hi ${hi.gasUsed} must exceed lo ${lo.gasUsed})`);
    });
});
