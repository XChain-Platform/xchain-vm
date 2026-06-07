/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Allocation-size gas metering (F3)
 *
 * The AST meter charges a flat __gas(1) per call, so a bulk-allocation builtin
 * (new Array(1e8).fill, 'x'.repeat(1e9), Array.from({length:1e8})) cost ~2 gas
 * while V8 materialized hundreds of MB — on x86 the worker then churned ~28s to
 * the wall-clock timeout (a cheap liveness-degradation; the backstop that fired
 * was arch/timing-dependent). The harness now wraps these builtins at the
 * PROTOTYPE level to charge __gas(size) BEFORE delegating, so the deterministic
 * gas ceiling rejects the allocation first. Defense-in-depth — the out-of-process
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
        assert.ok(Date.now() - t0 < 2000, 'must fail fast — the allocation never reaches V8 (got ' + (Date.now() - t0) + 'ms)');
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
