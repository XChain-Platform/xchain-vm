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


// Output-size metering upgrades for join() and default-comparator sort(), gated
// on the same block-time flag-day as the O(n)-copy upgrades above
// (XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME):
//   #130  Array.prototype.join() charged element count while its real cost is the
//         converted OUTPUT length (also backs String(arr) / arr+'' / template
//         interpolation) → post-gate it charges the returned string's length,
//         mirroring the JSON.stringify post-charge.
//   #152  default (no-comparator) sort/toSorted charged O(n) while V8 does
//         O(n log n) ToString compares → post-gate it charges n*ceil(log2 n)
//         plus one pass of string-element bytes; a USER comparator already runs
//         metered contract code per compare, so that path is unchanged.
// Below the gate both replay the legacy element-count charge byte-for-bit.

(XChainVM ? describe : describe.skip)('output-size metering: join + default sort (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #130: join charged by output string length ----
    // 200 elements x 1000 chars → ~200k output chars for a 200-element join.
    const J = 200, L = 1000;
    const JOIN_BUILD = `var s='x'.repeat(${L}); var a=new Array(${J}).fill(s);`;
    const joinBase = `module.exports=function(){ ${JOIN_BUILD} return a.length; };`;
    const joinOp   = `module.exports=function(){ ${JOIN_BUILD} return a.join('').length; };`;

    it('#130 join() is charged by output length above the gate', async function () {
        const base = await above(joinBase);
        const op = await above(joinOp);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= J * L * 0.5,
            `join must add ~${J * L} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#130 join() adds ~element-count gas below the gate (historical replay preserved)', async function () {
        const base = await below(joinBase);
        const op = await below(joinOp);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed < 5000,
            `pre-gate join must charge ~${J} (element count), got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#130 String(arr) rides the same output-length charge above the gate', async function () {
        const base = await above(joinBase);
        const op = await above(`module.exports=function(){ ${JOIN_BUILD} return String(a).length; };`);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= J * L * 0.5,
            `String(arr) must add ~${J * L} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#130 a small join stays cheap above the gate', async function () {
        const r = await above(`module.exports=function(){ return ['a','b','c'].join('-'); };`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'a-b-c');
        assert.ok(r.gasUsed < 1000, 'small join must not be over-charged, got ' + r.gasUsed);
    });

});

(XChainVM ? describe : describe.skip)('output-size metering: join + default sort (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // ---- #152: default-comparator sort charged n*ceil(log2 n) + string bytes ----
    const S = 10000; // ceil(log2 10000) = 14 → ~140k compare gas
    const SORT_BUILD = `var a=new Array(${S}); for(var i=0;i<${S};i++) a[i]=(i*7919)%${S};`;
    const sortBase = `module.exports=function(){ ${SORT_BUILD} return a.length; };`;
    const sortOp   = `module.exports=function(){ ${SORT_BUILD} a.sort(); return a[0]; };`;

    it('#152 default sort() is charged ~n*log2(n) above the gate', async function () {
        const base = await above(sortBase);
        const op = await above(sortOp);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= S * 10,
            `default sort must add ~${S * 14} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#152 default sort() adds ~element-count gas below the gate (historical replay preserved)', async function () {
        const base = await below(sortBase);
        const op = await below(sortOp);
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        const delta = op.gasUsed - base.gasUsed;
        assert.ok(delta < S * 3,
            `pre-gate default sort must charge ~${S} (element count), got delta ${delta}`);
    });

    it('#152 string elements add their byte volume above the gate', async function () {
        const K = 500, W = 200; // 500 strings x 200 chars → +100k byte charge
        const BUILD = `var s='y'.repeat(${W}); var a=new Array(${K});
            for(var i=0;i<${K};i++) a[i]=s+(i%10);`;
        const base = await above(`module.exports=function(){ ${BUILD} return a.length; };`);
        const op = await above(`module.exports=function(){ ${BUILD} a.sort(); return a.length; };`);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= K * W * 0.5,
            `string sort must add >= ~${K * W} byte gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

});

(XChainVM ? describe : describe.skip)('output-size metering: join + default sort (gated)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });
    const S = 10000;
    const SORT_BUILD = `var a=new Array(${S}); for(var i=0;i<${S};i++) a[i]=(i*7919)%${S};`;
    const sortBase = `module.exports=function(){ ${SORT_BUILD} return a.length; };`;

    it('#152 a USER-comparator sort is charged identically on both sides of the gate', async function () {
        // With a comparator every compare runs metered contract code, so the
        // wrapper keeps the legacy O(n) charge; the program must cost the SAME
        // gas above and below the flag-day.
        const CMP = `module.exports=function(){ ${SORT_BUILD} a.sort(function(x,y){ return x-y; }); return a[0]; };`;
        const lo = await below(CMP);
        const hi = await above(CMP);
        assert.strictEqual(lo.success, true, lo.error);
        assert.strictEqual(hi.success, true, hi.error);
        assert.strictEqual(hi.gasUsed, lo.gasUsed,
            'comparator-sort gas must be unchanged across the gate');
        assert.strictEqual(hi.returnValue, lo.returnValue);
    });

    it('#152 toSorted() rides the same default-comparator charge above the gate', async function () {
        const base = await above(sortBase);
        const op = await above(`module.exports=function(){ ${SORT_BUILD} var b=a.toSorted(); return b[0]; };`);
        assert.strictEqual(op.success, true, op.error);
        assert.ok(op.gasUsed - base.gasUsed >= S * 10,
            `toSorted must add ~${S * 14} gas above the gate, got delta ${op.gasUsed - base.gasUsed}`);
    });

    it('#152 a small default sort stays cheap above the gate', async function () {
        const r = await above(`module.exports=function(){ return [3,1,2].sort().join(','); };`);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), '1,2,3');
        assert.ok(r.gasUsed < 1000, 'small sort must not be over-charged, got ' + r.gasUsed);
    });
});
