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
 * Math output-size DoS guard (F-MO)
 *
 * xchain.math runs HOST-SIDE (ivm.Reference), outside the isolate's gas
 * ceiling, 8MB memory limit and wall-clock net. The 256-char INPUT cap bounds
 * add/subtract/multiply/divide/mod/sqrt/log (output magnitude <= input
 * magnitude) but NOT pow: a tiny exponent yields an astronomically large
 * magnitude, whose fixed-notation string mathjs.format() materializes on the
 * host. pow('10','10000000') allocates a 10MB string in ~340ms; pow('10','1e9')
 * OOM-crashes the node process. All for ~0 gas: an unmetered host DoS /
 * crash-on-demand.
 *
 * The guard charges gas proportional to the result's PREDICTED fixed-notation
 * length (derived from the bignumber decimal exponent, without expanding it)
 * BEFORE format() runs, so an oversized result trips the deterministic gas
 * ceiling (out_of_gas, un-swallowable) instead of the host allocator. Only the
 * length beyond a 256-char threshold is charged, so ordinary small-number math
 * is unaffected. CONSENSUS-GATED on the same block-time flag-day as
 * F3-binary/globals + F-NR; below the gate math billing is unchanged.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const CEILING = 1000000;
const BELOW = { height: 100, timestamp: 1700000000, hash: 'abc' }; // < gate
const ABOVE = { height: 200, timestamp: 1900000000, hash: 'def' }; // >= gate
const fn = (body) => `module.exports = function(xchain){ ${body} };`;

(XChainVM ? describe : describe.skip)('math output-size DoS guard (F-MO)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM({ maxCpuTimeMs: 8000, gasCeiling: CEILING }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, block) => execute(vm, fn(body), { method: 'default', blockContext: block });

    // ---- Below the gate: unmetered (legacy behaviour preserved for replay) ----
    it('below the gate, a small pow still returns its full string (replay preserved)', async function () {
        const r = await run(`return xchain.math.pow('10','5000');`, BELOW);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue).length, 5001);
    });

    // ---- Above the gate: the host DoS / crash cases fail FAST as out_of_gas
    //      (charged before mathjs.format allocates), never the allocator. ----
    const dosCases = {
        "pow('10','10000000') (~10MB output)":  `return xchain.math.pow('10','10000000');`,
        "pow('7','30000000') (~25MB output)":   `return xchain.math.pow('7','30000000');`,
        "pow('10','1000000000') (OOM crash)":   `return xchain.math.pow('10','1000000000');`,
        "pow('10','-10000000') (tiny fraction)":`return xchain.math.pow('10','-10000000');`,
    };
    for (const [name, body] of Object.entries(dosCases)) {
        it(`above the gate, ${name} is a fast out_of_gas (no host allocation)`, async function () {
            const t0 = Date.now();
            const r = await run(body, ABOVE);
            assert.strictEqual(r.success, false, 'must fail: ' + r.returnValue);
            assert.match(r.error, /^out_of_gas:/, r.error);
            assert.strictEqual(r.gasUsed, CEILING, 'resource fault clamps gasUsed to ceiling');
            assert.ok(Date.now() - t0 < 1000, 'must fail before the allocation (got ' + (Date.now() - t0) + 'ms)');
        });
    }

    // ---- Above the gate: the gas fault cannot be swallowed and resumed ----
    it('above the gate, catching the pow out_of_gas in a loop still terminates out_of_gas', async function () {
        const r = await run(`for(var i=0;i<100;i++){ try{ xchain.math.pow('10','10000000'); }catch(e){} } return 'survived';`, ABOVE);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.notStrictEqual(JSON.parse(r.returnValue || 'null'), 'survived');
    });

    // ---- Above the gate: throughput (many medium pow) is gas-bounded ----
    it('above the gate, a loop of medium pow is gas-bounded (no unmetered host churn)', async function () {
        const t0 = Date.now();
        const r = await run(`for(var i=0;i<100000;i++){ xchain.math.pow('10','5000'); } return 'done';`, ABOVE);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.ok(Date.now() - t0 < 3000, 'must be gas-bounded, not churn host CPU');
    });

    // ---- Above the gate: ordinary math is untouched (no false charge) ----
    it('above the gate, small-number math is unchanged and cheap', async function () {
        const r1 = await run(`return xchain.math.add('5','7');`, ABOVE);
        assert.strictEqual(JSON.parse(r1.returnValue), '12');
        assert.ok(r1.gasUsed < 500, 'small add must stay cheap: ' + r1.gasUsed);
        const r2 = await run(`return xchain.math.multiply('123456','789');`, ABOVE);
        assert.strictEqual(JSON.parse(r2.returnValue), '97406784');
        const r3 = await run(`return xchain.math.pow('2','64');`, ABOVE);
        assert.strictEqual(JSON.parse(r3.returnValue), '18446744073709551616');
    });

    it('above the gate, a legitimate medium pow is priced but succeeds', async function () {
        const r = await run(`return xchain.math.pow('10','5000');`, ABOVE);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue).length, 5001);
        assert.ok(r.gasUsed > 4000 && r.gasUsed < CEILING, 'priced by output length: ' + r.gasUsed);
    });
});
