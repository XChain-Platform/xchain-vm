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
 * Emission prototype-key strip: recursive (F-PS)
 *
 * EmissionCollector.add() must strip `__proto__`/`constructor` OWN keys from
 * emitted params so a contract cannot hand a prototype-pollution payload to the
 * indexer. The original strip was shallow (top-level only), so a NESTED own
 * `__proto__` (reachable via JSON.parse, which creates a normal own key instead
 * of invoking the prototype setter) survived into the emission. The recursive
 * strip cleans every level. CONSENSUS-GATED on the same block-time flag-day as
 * F3-binary/globals + F-NR + F-MO: below the gate the legacy shallow strip runs
 * (replay preserved); a param with no proto keys hashes identically either way.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const EmissionCollector = require('../../src/collector.js');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const BELOW = { height: 1, timestamp: 1700000000, hash: 'a' }; // < gate
const ABOVE = { height: 2, timestamp: 1900000000, hash: 'b' }; // >= gate
const fn = (body) => `module.exports = function(xchain){ ${body} };`;

// A nested own __proto__/constructor payload built via JSON.parse (own keys, not
// the prototype setter), plus a clean top-level field.
const NESTED_POLLUTION =
    `var n = JSON.parse('{"__proto__":{"evil":1},"constructor":{"bad":2},"good":3}');` +
    `xchain.emit.broadcast({ nested: n, deep: { inner: JSON.parse('{"__proto__":{"x":1},"ok":9}') }, plain: 'v' });` +
    `return 'done';`;

describe('EmissionCollector recursive proto-strip (unit)', function () {
    it('deepStrip=false leaves a nested __proto__ own key (legacy shallow behaviour)', function () {
        const c = new EmissionCollector(50, false);
        c.add('X', { nested: JSON.parse('{"__proto__":{"evil":1},"good":3}') });
        assert.ok(Object.prototype.hasOwnProperty.call(c.getActions()[0].params.nested, '__proto__'),
            'legacy path keeps the nested own __proto__');
    });

    it('deepStrip=true removes __proto__/constructor own keys at every level', function () {
        const c = new EmissionCollector(50, true);
        c.add('X', {
            nested: JSON.parse('{"__proto__":{"evil":1},"constructor":{"bad":2},"good":3}'),
            arr: [JSON.parse('{"__proto__":{"z":1},"keep":7}')],
            plain: 'v'
        });
        const p = c.getActions()[0].params;
        assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), {
            nested: { good: 3 }, arr: [{ keep: 7 }], plain: 'v'
        });
        // The emitted containers are prototype-free at every level.
        assert.strictEqual(Object.getPrototypeOf(p), null);
        assert.strictEqual(Object.getPrototypeOf(p.nested), null);
    });

    it('deepStrip=true leaves a clean param byte-identical to the shallow output', function () {
        const clean = { a: 1, b: [1, 2, { c: 'd' }], e: { f: 'g' } };
        const shallow = new EmissionCollector(50, false); shallow.add('X', clean);
        const deep = new EmissionCollector(50, true); deep.add('X', clean);
        assert.strictEqual(
            JSON.stringify(shallow.getActions()), JSON.stringify(deep.getActions()),
            'clean params must hash identically across the gate');
    });
});

(XChainVM ? describe : describe.skip)('emission proto-strip through the VM (F-PS gate)', function () {
    this.timeout(30000);
    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('below the gate, nested __proto__ survives into the emission (replay preserved)', async function () {
        const r = await execute(vm, fn(NESTED_POLLUTION), { method: 'default', blockContext: BELOW });
        const params = r.emittedActions[0].params;
        assert.ok(Object.prototype.hasOwnProperty.call(params.nested, '__proto__'));
    });

    it('above the gate, nested __proto__/constructor are stripped from the emission', async function () {
        const r = await execute(vm, fn(NESTED_POLLUTION), { method: 'default', blockContext: ABOVE });
        // Compare via JSON (the hashed form): prototypes are irrelevant, dropped keys are not.
        const params = JSON.parse(JSON.stringify(r.emittedActions[0].params));
        assert.deepStrictEqual(params.nested, { good: 3 });
        assert.deepStrictEqual(params.deep, { inner: { ok: 9 } });
        assert.strictEqual(params.plain, 'v');
    });

    it('a clean-param emission hashes identically below and above the gate', async function () {
        const clean = fn(`xchain.emit.broadcast({a:1,b:[1,2,{c:'d'}],e:{f:'g'}}); return 'd';`);
        const rb = await execute(vm, clean, { method: 'default', blockContext: BELOW });
        const ra = await execute(vm, clean, { method: 'default', blockContext: ABOVE });
        assert.strictEqual(JSON.stringify(rb.emittedActions), JSON.stringify(ra.emittedActions));
    });
});
