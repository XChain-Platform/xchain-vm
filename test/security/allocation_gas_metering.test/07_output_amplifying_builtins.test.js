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


// Output-amplifying builtins metered by RECEIVER length only.
//
// The generic __meterLen wrapper charges the receiver and delegates, which is
// correct for every method whose output is bounded by its receiver. Three were
// not: String.prototype.replace / replaceAll (output = receiver + matches *
// (replacement - search)) and %TypedArray%.prototype.join (output = rendered
// element bytes + separators). Measured at the pre-fix revision, a 100-iteration
// reuse loop moved ~20M chars for ~101k gas (replaceAll), ~20M for ~301k
// (replace) and ~2.1M for 312 gas (TypedArray join): O(output) native work for
// O(receiver) gas, so the per-node wall-clock net (not a consensus value) binds
// before the deterministic gas ceiling and success-vs-resource-failure becomes
// host-dependent. Same divergence class the join/flat/stringify output-aware
// charges already close, and gated on the same flag-day so replay below it is
// byte-identical.

(XChainVM ? describe : describe.skip)('output-amplifying builtins are charged by output (#4389)', function () {
    this.timeout(60000);

    const AMP_CEILING = 1000000;
    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: AMP_CEILING, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });
    const fn = (body) => `module.exports=function(){ ${body} };`;

    // Reuse loops: the receiver and the replacement are built ONCE (and charged
    // once), so every further iteration is pure amplification.
    const AMP_REPLACE_ALL = fn(`var s='a'.repeat(1000), r='b'.repeat(200), t=0;
        for(var i=0;i<100;i++){ t+=s.replaceAll('a',r).length; } return t;`);
    const AMP_REPLACE = fn(`var s='a'.repeat(1000), r='b'.repeat(200000), t=0;
        for(var i=0;i<100;i++){ t+=s.replace('a',r).length; } return t;`);
    const AMP_TA_JOIN = fn(`var a=new Uint8Array(1000), t=0;
        for(var i=0;i<100;i++){ t+=a.join('xxxxxxxxxxxxxxxxxxxx').length; } return t;`);

    const ampCases = [
        ['String.prototype.replaceAll', AMP_REPLACE_ALL],
        ['String.prototype.replace', AMP_REPLACE],
        ['%TypedArray%.prototype.join', AMP_TA_JOIN]
    ];

    for (const [name, code] of ampCases) {
        it(`above the gate, a ${name} reuse loop is a deterministic out_of_gas`, async function () {
            const r = await above(code);
            assert.strictEqual(r.success, false, 'amplification must not run to completion: ' + r.gasUsed);
            assert.match(r.error, /^out_of_gas:/, r.error);
            assert.strictEqual(r.gasUsed, AMP_CEILING, 'gasUsed clamps to the ceiling (fee-bounded, hashed)');
        });

        it(`below the gate, the same ${name} loop still completes on the legacy charge (replay preserved)`, async function () {
            const r = await below(code);
            assert.strictEqual(r.success, true, r.error);
        });
    }

});

(XChainVM ? describe : describe.skip)('output-amplifying builtins are charged by output (#4389)', function () {
    this.timeout(60000);

    const AMP_CEILING = 1000000;
    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: AMP_CEILING, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
    const ACTIVE = { height: 100, timestamp: GATE, hash: 'abc123' };
    const LEGACY = { height: 100, timestamp: GATE - 1, hash: 'abc123' };
    const above = (code) => execute(vm, code, { method: 'default', blockContext: ACTIVE });
    const below = (code) => execute(vm, code, { method: 'default', blockContext: LEGACY });
    const fn = (body) => `module.exports=function(){ ${body} };`;

    // The charge is max(receiver, result), not result alone: a replacement that
    // SHRINKS the string must still pay for the receiver scan, and a call whose
    // output cannot exceed the receiver must cost exactly what it cost before the
    // flag day. Both variants build the same values and make the same number of
    // calls, so any gas difference is the metering change alone.
    const HIT  = fn(`var s='a'.repeat(200), r='b'.repeat(200), t=0;
        for(var i=0;i<10;i++){ t+=s.replaceAll('a',r).length; } return t;`);
    const MISS = fn(`var s='a'.repeat(200), r='b'.repeat(200), t=0;
        for(var i=0;i<10;i++){ t+=s.replaceAll('zzz',r).length; } return t;`);

    // Tolerance, not equality: the two programs differ by a search literal and by
    // the magnitude they accumulate, which the instruction meter bills a couple of
    // units for. The signal is 200x wider than that floor (the expansion is ~398k
    // gas above the gate), so a leak cannot hide under it.
    it('below the gate, an expanding and a non-matching replaceAll cost the same receiver-only charge (legacy)', async function () {
        const hit = await below(HIT);
        const miss = await below(MISS);
        assert.strictEqual(hit.success, true, hit.error);
        assert.strictEqual(miss.success, true, miss.error);
        assert.ok(Math.abs(hit.gasUsed - miss.gasUsed) < 1000,
            `the output-aware charge must not leak below the flag day, got ${hit.gasUsed} vs ${miss.gasUsed}`);
    });

    it('above the gate, an expanding replaceAll costs strictly more than a non-matching one', async function () {
        const hit = await above(HIT);
        const miss = await above(MISS);
        assert.strictEqual(hit.success, true, hit.error);
        assert.strictEqual(miss.success, true, miss.error);
        assert.ok(hit.gasUsed > miss.gasUsed + 100000,
            `expansion must be billed, got ${hit.gasUsed} vs ${miss.gasUsed}`);
    });

    it('a replace whose output cannot exceed the receiver is unaffected by the flag day (no over-charge)', async function () {
        const b = await below(MISS);
        const a = await above(MISS);
        assert.strictEqual(a.gasUsed, b.gasUsed,
            'receiver-bounded string work must not move across the flag day');
    });
});
