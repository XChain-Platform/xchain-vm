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
 * Destructuring-rest metering: REST_PATTERN_METER block-time flag-day gate
 *
 * transformAllocators dispatched purely on EXPRESSION node types
 * (ArrayExpression/ObjectExpression carrying a SpreadElement), but a
 * destructuring rest is an ArrayPattern/ObjectPattern carrying a RestElement.
 * It matched no branch, so `var [...c] = bigArr` performed an unbounded native
 * O(n) copy for a flat __gas(1): a loop of bounded copies re-copied a source
 * that was charged ONCE at build, decoupling native CPU from gas and making a
 * run's success-vs-wall-clock-timeout depend on how fast the executing machine
 * is. Identical failure mode to the one CALL_SPREAD_METER was minted to close.
 *
 * This suite pins both halves of the gate:
 *   - BELOW the flag-day: gasUsed is byte-identical to the legacy value, and the
 *     copy is still flat in the size of the source (the historical behaviour a
 *     from-genesis replay must reproduce);
 *   - AT/AFTER it: gasUsed scales with the elements/own-keys actually copied, and
 *     a copy loop over a large source is a deterministic out_of_gas.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');
const { REST_PATTERN_METER_GATE_BLOCK_TIME } = require('../../src/index.js');

// The gate keys on BLOCK TIME. Below/at are one second apart so nothing else moves.
const BELOW = REST_PATTERN_METER_GATE_BLOCK_TIME - 1;
const AT    = REST_PATTERN_METER_GATE_BLOCK_TIME;

// 50 array-rest copies of an n-element source. The source itself is charged ONCE
// (new Array(n).fill), so any size-dependence in the DELTA is the copy being billed.
const arrRest = (n) => `module.exports = function(){
    var a = new Array(${n}).fill(7); var t = 0;
    for (var i = 0; i < 50; i++) { var [...c] = a; t += c.length; }
    return t;
};`;

// 50 object-rest copies of an n-own-key source.
const objRest = (n) => `module.exports = function(){
    var o = {}; for (var k = 0; k < ${n}; k++) { o['k' + k] = k; }
    var t = 0;
    for (var i = 0; i < 50; i++) { var {...c} = o; t += 1; }
    return t;
};`;

(XChainVM ? describe : describe.skip)('destructuring-rest metering: REST_PATTERN_METER gate', function () {
    this.timeout(60000);

    const runAt = (code, timestamp, ceiling) => {
        const vm = createVM({ gasCeiling: ceiling || 50000000, maxCpuTimeMs: 20000, maxMemory: 128 });
        vm.beginBlock();
        return execute(vm, code, {
            method: 'default',
            network: 'mainnet',
            blockContext: { height: 100, timestamp, hash: 'h' },
            contractAddress: 'C:BTC:1'
        }).then((r) => { vm.endBlock(); return r; });
    };

    // ---- array rest -------------------------------------------------------
    it('below the gate: 50 copies of a 20000-element source cost ~nothing (the bug)', async function () {
        const small = await runAt(arrRest(200), BELOW);
        const big   = await runAt(arrRest(20000), BELOW);
        assert.strictEqual(small.success, true, small.error);
        assert.strictEqual(big.success, true, big.error);
        // The whole delta is the SOURCE build (new Array(n).fill charges n). The one
        // million elements the 50 rest copies moved add ~2 gas on top of it.
        const buildDelta = 20000 - 200;
        assert.ok(big.gasUsed - small.gasUsed < buildDelta + 100,
            'pre-gate the copy must stay flat (historical behaviour); delta was ' +
            (big.gasUsed - small.gasUsed) + ' vs source-build alone ' + buildDelta);
    });

    it('at the gate: gasUsed scales with the elements actually copied', async function () {
        const below = await runAt(arrRest(20000), BELOW);
        const at    = await runAt(arrRest(20000), AT);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(JSON.parse(at.returnValue), JSON.parse(below.returnValue),
            'metering must not change what the contract computes');
        // 50 iterations x 20000 elements = 1,000,000 elements copied, charged by count.
        assert.strictEqual(at.gasUsed - below.gasUsed, 50 * 20000,
            'the charge is exactly the elements copied (' + below.gasUsed + ' -> ' + at.gasUsed + ')');
    });

    it('at the gate: a copy loop over a large source is a deterministic out_of_gas', async function () {
        const r = await runAt(arrRest(20000), AT, 500000);
        assert.strictEqual(r.success, false,
            'metered copy loop must exhaust gas: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_gas:|^out_of_resource:/, r.error);
        // ...and below the gate the identical contract SUCCEEDS on the same ceiling,
        // which is the whole gas/CPU decoupling this closes.
        const legacy = await runAt(arrRest(20000), BELOW, 500000);
        assert.strictEqual(legacy.success, true,
            'pre-gate the same loop must still succeed (byte-identical replay): ' + legacy.error);
    });

    // ---- object rest ------------------------------------------------------
    it('below the gate: 50 own-key copies of a 20000-key source cost ~nothing (the bug)', async function () {
        const small = await runAt(objRest(200), BELOW);
        const big   = await runAt(objRest(20000), BELOW);
        assert.strictEqual(small.success, true, small.error);
        assert.strictEqual(big.success, true, big.error);
        // The source build is a loop of n assignments (~2 gas/key), so that is the
        // whole delta; the 1,000,000 own-keys the rest copies add nothing.
        assert.ok(big.gasUsed - small.gasUsed < 2 * (20000 - 200) + 100,
            'pre-gate the own-key copy must stay flat; delta was ' + (big.gasUsed - small.gasUsed));
    });

    it('at the gate: gasUsed scales with the own-keys actually copied', async function () {
        const below = await runAt(objRest(20000), BELOW);
        const at    = await runAt(objRest(20000), AT);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(at.gasUsed - below.gasUsed, 50 * 20000,
            'the charge is exactly the own-keys copied (' + below.gasUsed + ' -> ' + at.gasUsed + ')');
    });

    // ---- gate parity ------------------------------------------------------
    // The load-bearing replay property: one second below the flag-day, gasUsed for a
    // rest-using contract must be EXACTLY what it is today. A drift here forks the
    // fleet on every historical block that touched a rest pattern.
    it('one second below the gate, gasUsed is byte-identical to the un-metered value', async function () {
        const a = await runAt(arrRest(500), BELOW);
        const b = await runAt(arrRest(500), REST_PATTERN_METER_GATE_BLOCK_TIME - 100000);
        assert.strictEqual(a.success, true, a.error);
        assert.strictEqual(a.gasUsed, b.gasUsed,
            'pre-gate gasUsed must not depend on how far below the flag-day the block sits');
        const o1 = await runAt(objRest(500), BELOW);
        const o2 = await runAt(objRest(500), REST_PATTERN_METER_GATE_BLOCK_TIME - 100000);
        assert.strictEqual(o1.gasUsed, o2.gasUsed);
    });

    it('a rest-LESS destructure is unchanged on both sides of the gate', async function () {
        // The __arrspread wrap DRAINS the iterable, so it must fire only for a pattern
        // that would drain it anyway. A rest-less pattern must be byte-identical.
        const code = `module.exports = function(){
            var a = new Array(5000).fill(7); var t = 0;
            for (var i = 0; i < 50; i++) { var [x, y] = a; t += x + y; }
            return t;
        };`;
        const below = await runAt(code, BELOW);
        const at    = await runAt(code, AT);
        assert.strictEqual(below.success, true, below.error);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(at.gasUsed, below.gasUsed,
            'a rest-less destructure must not be metered (or a lazy source would be over-drained)');
    });

    // ---- semantics --------------------------------------------------------
    it('at the gate: the rest bindings still hold exactly what they held before', async function () {
        const code = `module.exports = function(){
            var a = [1,2,3,4,5];
            var [p, q, ...c] = a;
            var o = {x:1, y:2, z:3};
            var {x, ...rest} = o;
            return JSON.stringify([p, q, c, x, Object.keys(rest).sort()]);
        };`;
        const below = await runAt(code, BELOW);
        const at    = await runAt(code, AT);
        assert.strictEqual(below.success, true, below.error);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(at.returnValue, below.returnValue,
            'the rewrite must not change what the destructure produces');
        assert.strictEqual(JSON.parse(JSON.parse(at.returnValue))[2].join(','), '3,4,5');
    });

    it('at the gate: a null/undefined object-rest source still throws, deterministically', async function () {
        const code = `module.exports = function(){ var o = null; var {k, ...c} = o; return 'unreachable'; };`;
        const at1 = await runAt(code, AT);
        const at2 = await runAt(code, AT);
        assert.strictEqual(at1.success, false, 'destructuring null must still throw');
        assert.strictEqual(at1.error, at2.error,
            'the failure must be identical on every node: ' + at1.error + ' vs ' + at2.error);
        assert.match(at1.error, /Cannot destructure/, at1.error);
    });

    it('at the gate: a non-iterable array-rest source still throws, deterministically', async function () {
        const code = `module.exports = function(){ var a = 5; var [...c] = a; return 'unreachable'; };`;
        const at1 = await runAt(code, AT);
        const at2 = await runAt(code, AT);
        assert.strictEqual(at1.success, false, 'destructuring a non-iterable must still throw');
        assert.strictEqual(at1.error, at2.error,
            'the failure must be identical on every node: ' + at1.error + ' vs ' + at2.error);
        assert.match(at1.error, /is not iterable/, at1.error);
        // The message TEXT moves at the flag-day (V8 names the helper's local instead of
        // the source expression). That is a gated, deterministic change, not a divergence
        // -- pin it so a future edit cannot move it silently OUTSIDE a flag-day.
        const below = await runAt(code, BELOW);
        assert.strictEqual(below.success, false);
        assert.match(below.error, /a is not iterable/, 'pre-gate message names the SOURCE: ' + below.error);
        assert.match(at1.error, /val is not iterable/, 'post-gate message names the helper local: ' + at1.error);
    });
});
