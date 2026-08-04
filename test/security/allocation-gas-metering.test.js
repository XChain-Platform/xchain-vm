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
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const CEILING = 1000000;

(XChainVM ? describe : describe.skip)('allocation-size gas metering (F3)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (code) => execute(vm, code, { method: 'default' });

    it('Array(n).fill is charged by length → out_of_gas before V8 allocates (no stall)', async function () {
        const t0 = Date.now();
        const r = await run(`module.exports = function(){ var a = new Array(100000000).fill('x'); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'must be gas-bounded, got: ' + r.error);
        assert.strictEqual(r.gasUsed, CEILING, 'gasUsed must clamp to the ceiling (fee-bounded, hashed)');
        assert.ok(Date.now() - t0 < 2000, 'must fail fast; the allocation never reaches V8 (got ' + (Date.now() - t0) + 'ms)');
    });

    it('String.repeat is charged by count*length', async function () {
        const r = await run(`module.exports = function(){ return 'x'.repeat(1000000000); };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });

    it('Array.from({length:n}) is charged by length', async function () {
        const r = await run(`module.exports = function(){ var a = Array.from({length:100000000}); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });

    it('prototype-level metering is aliasing-proof (var f = [].fill; f.call(...))', async function () {
        const r = await run(`module.exports = function(){ var f = [].fill; var a = new Array(100000000); f.call(a, 'x'); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'an aliased native must still be metered, got: ' + r.error);
    });

    it('legitimate small allocations still succeed and are charged proportionally', async function () {
        const ok = await run(`module.exports = function(){ var a = new Array(100).fill(7); return a.length; };`);
        assert.strictEqual(ok.success, true, ok.error);
        assert.strictEqual(ok.returnValue, '100');
        assert.ok(ok.gasUsed >= 100, 'should be charged ~the fill length, got ' + ok.gasUsed);

        const rep = await run(`module.exports = function(){ return 'ab'.repeat(10); };`);
        assert.strictEqual(rep.success, true, rep.error);
        assert.strictEqual(rep.returnValue, JSON.stringify('ab'.repeat(10)));
    });
});

// ===========================================================================
// Allocation-size gas metering: binary buffers (F3-binary)
//
// ArrayBuffer + TypedArray constructors allocate a dense backing store at
// [[Construct]] time. Unmetered, new Uint8Array(1<<20) costs ~3 gas while
// allocating 1 MiB; near the isolate memory limit the allocation throws a
// CATCHABLE RangeError, letting a contract observe heap/GC state and write a
// nondeterministic value into hashed state. The constructors are now charged by
// requested byte length so the gas ceiling binds first (deterministically,
// before the memory limit is reachable) and the failure is an uncatchable
// out_of_gas rather than a catchable allocation error.
// ===========================================================================

(XChainVM ? describe : describe.skip)('allocation-size gas metering: binary buffers (F3-binary)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    // F3-binary metering is gated on a coordinated block-time flag-day
    // (XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME): below it the ArrayBuffer/TypedArray
    // constructors are intentionally unmetered (pre-activation behavior, so a
    // mixed-version fleet cannot fork on a historical block). These tests assert
    // the POST-activation charge, so they must run at/after the flag day. The
    // pre/post split itself is locked by the binary-alloc-gate regression test.
    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE_CONTEXT = { height: 100, timestamp: GATE, hash: 'abc123' };
    const run = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE_CONTEXT });

    it('new Uint8Array(n) is charged by byte length → out_of_gas before V8 allocates (no stall)', async function () {
        const t0 = Date.now();
        const r = await run(`module.exports = function(){ var a = new Uint8Array(1 << 30); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'must be gas-bounded, got: ' + r.error);
        assert.strictEqual(r.gasUsed, CEILING, 'gasUsed must clamp to the ceiling (fee-bounded, hashed)');
        assert.ok(Date.now() - t0 < 2000, 'must fail fast; the allocation never reaches V8 (got ' + (Date.now() - t0) + 'ms)');
    });

    it('the caught-allocation determinism attack is an uncatchable out_of_gas, not a catchable RangeError', async function () {
        // The finding's exact pattern: spin allocating 1 MiB buffers inside a
        // try/catch hoping to swallow the memory-limit error and read a
        // GC-timing-dependent count. The byte-length charge means the FIRST
        // 1-MiB allocation already exceeds the ceiling, and gas exhaustion (unlike
        // the RangeError) cannot be caught, so no nondeterministic value is ever
        // observable, and the result is identical on every validator.
        const r = await run(`module.exports = function(){
            var n = 0;
            try { var bufs = []; for(;;){ bufs.push(new Uint8Array(1 << 20)); n++; } } catch(e) {}
            return String(n);
        };`);
        assert.strictEqual(r.success, false, 'the caught loop must NOT return a value');
        assert.match(r.error, /^out_of_gas:/, 'must be uncatchable out_of_gas, got: ' + r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });

    it('new ArrayBuffer(n) is charged by byte length', async function () {
        const r = await run(`module.exports = function(){ var b = new ArrayBuffer(1 << 30); return b.byteLength; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });

    it('metering cannot be sidestepped via the instance constructor ((new X()).constructor)', async function () {
        const r = await run(`module.exports = function(){ var U = (new Uint8Array(0)).constructor; var a = new U(1 << 30); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'the rerouted constructor must still be metered, got: ' + r.error);
    });

    it('wide elements are charged by bytes, not element count (Float64Array → *8)', async function () {
        // 200M elements * 8 bytes = 1.6e9 > ceiling; element count alone (2e8) also
        // exceeds it, but the *8 ensures wide-element arrays can never undercharge.
        const r = await run(`module.exports = function(){ var a = new Float64Array(200000000); return a.length; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });

    it('legitimate small binary allocations still succeed, with instanceof and statics intact', async function () {
        const ok = await run(`module.exports = function(){
            var a = new Uint8Array(64);
            var fromOk = (Uint8Array.from([1,2,3]).length === 3);
            return [a.length, a instanceof Uint8Array, fromOk, a.constructor === Uint8Array];
        };`);
        assert.strictEqual(ok.success, true, ok.error);
        assert.deepStrictEqual(JSON.parse(ok.returnValue), [64, true, true, true]);
        assert.ok(ok.gasUsed >= 64, 'should be charged ~the byte length, got ' + ok.gasUsed);

        // A view over an existing buffer makes no new backing store → not re-charged.
        const view = await run(`module.exports = function(){ var b = new ArrayBuffer(32); var v = new Uint8Array(b); return v.length; };`);
        assert.strictEqual(view.success, true, view.error);
        assert.strictEqual(view.returnValue, '32');
    });
});

// ===========================================================================
// Compute-size gas metering: O(n) global functions (F3-globals)
//
// The G1 block meters the O(n) Array/String/Object/JSON *methods*, but the
// standalone global functions that transcode or scan a whole string in native
// code for one call site were left uncharged: encode/decodeURIComponent,
// encode/decodeURI, escape/unescape (each allocates an O(n) transcoded copy)
// and parseInt/parseFloat (each scans the full string). Unmetered, a single
// 1 M-gas contract call looping decodeURIComponent over a 120k-char string
// burned ~13.5s of wall-clock while gasUsed stayed ~540k, so the per-node
// wall-clock net (not a consensus value) was the binding constraint: a cheap-fee
// throughput DoS + a timeout-vs-commit divergence across a heterogeneous fleet.
// The harness now charges the argument's string length before delegating.
// Same flag-day gate as F3-binary (both move gasUsed → must flip atomically).
// ===========================================================================

(XChainVM ? describe : describe.skip)('compute-size gas metering: global functions (F3-globals)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    const L = 200000;
    // Build an L-char identity-encoded string (digits are URI/escape-unreserved and
    // a valid numeric body) and either just measure it, or also run the op once.
    const BUILD = `var s=('5').repeat(${L});`;
    const baseline = `module.exports=function(){ ${BUILD} return s.length; };`;
    const withOp = (call) => `module.exports=function(){ ${BUILD} var r=${call}; return (''+r).length; };`;

    // Each global charges ~L gas for the single op, over the string-build cost.
    ['decodeURIComponent(s)', 'encodeURIComponent(s)', 'encodeURI(s)', 'decodeURI(s)',
     'escape(s)', 'unescape(s)', 'parseInt(s,10)', 'parseFloat(s)'].forEach(function (call) {
        it(`${call.split('(')[0]} is charged by argument length above the gate`, async function () {
            const base = await above(baseline);
            const op = await above(withOp(call));
            assert.strictEqual(base.success, true, base.error);
            assert.strictEqual(op.success, true, op.error);
            const delta = op.gasUsed - base.gasUsed;
            assert.ok(delta >= L * 0.5,
                `${call} must add ~${L} gas for the O(n) native work, got delta ${delta}`);
        });
    });

    it('below the gate the same op adds ~0 gas (historical replay preserved)', async function () {
        const base = await below(baseline);
        const op = await below(withOp('decodeURIComponent(s)'));
        assert.strictEqual(base.success, true, base.error);
        assert.strictEqual(op.success, true, op.error);
        const delta = op.gasUsed - base.gasUsed;
        assert.ok(delta < 1000,
            `pre-gate decodeURIComponent must stay unmetered (legacy), got delta ${delta}`);
    });

    it('the amplification loop is gas-bounded above the gate (fails fast, no wall-clock stall)', async function () {
        const t0 = Date.now();
        const r = await above(`module.exports=function(){
            var s=('%41').repeat(40000); var sink=0;
            for(var i=0;i<100000;i++){ sink+=decodeURIComponent(s).length; }
            return sink; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, 'must be gas-bounded, got: ' + r.error);
        assert.ok(Date.now() - t0 < 3000,
            'must fail fast on gas, not grind to the wall-clock net (got ' + (Date.now() - t0) + 'ms)');
    });

    it('legitimate small calls stay cheap and correct above the gate', async function () {
        const r = await above(`module.exports=function(){
            return [decodeURIComponent('%41%42%43'), encodeURIComponent('a b'), parseInt('42',10), parseFloat('3.5')];
        };`);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(JSON.parse(r.returnValue), ['ABC', 'a%20b', 42, 3.5]);
        assert.ok(r.gasUsed < 1000, 'small string ops must not be over-charged, got ' + r.gasUsed);
    });
});

// ===========================================================================
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
// ===========================================================================

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

// ===========================================================================
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
// ===========================================================================

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

// ===========================================================================
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
// ===========================================================================

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

// ===========================================================================
// 2437: the host __gas sanitizer's NON-FINITE fallback.
// The legacy sanitizer collapsed Infinity/NaN units to a 1-gas charge, which
// broke its own documented "a huge units deterministically throws
// GasExhaustedError at the ceiling" invariant precisely where a wrapper failed
// to bound an allocation. Reachable: Array.prototype.fill on an array-like with
// length Infinity bills 1 gas and V8 then services ToLength(Infinity) = 2^53-1
// iterations, burning the whole wall-clock net (~30s measured) for ~0 gas, while
// the same call with a FINITE 2^53-1 length is a deterministic out_of_gas in
// ~10ms. Gated on the same armed flag-day as F3-binary/F-NR/F-MO/F-PS: it turns
// a 1-gas timeout into a ceiling-clamped out_of_gas, which moves hashed state.
// ===========================================================================

(XChainVM ? describe : describe.skip)('non-finite gas units fail closed (2437)', function () {
    this.timeout(60000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });

    // A cheap carrier of a non-finite size: V8 rejects repeat(Infinity) itself, so
    // this exercises the sanitizer without also running the 30s native loop.
    const INF_UNITS = `module.exports=function(){ try{ 'x'.repeat(Infinity); return 'no-throw'; }catch(e){ return 'CAUGHT:'+e.name; } };`;

    it('below the gate, a non-finite size still collapses to 1 gas (replay preserved)', async function () {
        const r = await below(INF_UNITS);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'CAUGHT:RangeError');
        assert.ok(r.gasUsed < 1000, 'legacy path bills ~1 gas for the non-finite unit: ' + r.gasUsed);
    });

    it('above the gate, a non-finite size is a deterministic out_of_gas', async function () {
        const r = await above(INF_UNITS);
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.returnValue, null, 'GasExhaustedError is not swallowable by the contract');
        assert.strictEqual(r.gasUsed, CEILING, 'gasUsed clamps to the ceiling (fee-bounded, hashed)');
    });

    it('above the gate, fill() on an Infinity-length array-like is gas-bounded, not a 30s wall-clock burn', async function () {
        const t0 = Date.now();
        const r = await above(`module.exports=function(){ var a={length:Infinity}; Array.prototype.fill.call(a,1); return 'no-throw'; };`);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.strictEqual(r.gasUsed, CEILING);
        assert.ok(Date.now() - t0 < 3000,
            'must fail on gas before V8 runs the loop (got ' + (Date.now() - t0) + 'ms)');
    });

    it('above the gate, the non-finite charge matches the finite 2^53-1 path exactly', async function () {
        const inf = await above(`module.exports=function(){ var a={length:Infinity}; Array.prototype.fill.call(a,1); return 1; };`);
        const fin = await above(`module.exports=function(){ var a={length:9007199254740991}; Array.prototype.fill.call(a,1); return 1; };`);
        assert.strictEqual(inf.error, fin.error,
            'a non-finite size must be indistinguishable from the maximal finite size: ' + inf.error + ' vs ' + fin.error);
        assert.strictEqual(inf.gasUsed, fin.gasUsed);
    });

    it('a finite size is unaffected on both sides of the gate', async function () {
        const code = `module.exports=function(){ var a=new Array(1000).fill('x'); return a.length; };`;
        const b = await below(code);
        const a = await above(code);
        assert.strictEqual(b.success, true, b.error);
        assert.strictEqual(a.success, true, a.error);
        assert.strictEqual(a.gasUsed, b.gasUsed, 'finite metering must not move across the flag day');
    });
});
