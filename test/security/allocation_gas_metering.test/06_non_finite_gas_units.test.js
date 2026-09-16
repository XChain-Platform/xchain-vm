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
