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
    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1790812800;
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

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1790812800;
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
