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

});

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
    const BUILD = `var s=('5').repeat(${L});`;
    const baseline = `module.exports=function(){ ${BUILD} return s.length; };`;
    const withOp = (call) => `module.exports=function(){ ${BUILD} var r=${call}; return (''+r).length; };`;
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
