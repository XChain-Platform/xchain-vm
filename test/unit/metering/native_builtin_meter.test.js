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
 * Native builtin meter: charge shape.
 *
 * Function.prototype.apply, String isWellFormed/toWellFormed, the Set algebra
 * family and Iterator toArray/drop are billed by operand size once the gate is
 * armed, so the charge must scale linearly with the operand and leave short
 * operands at the legacy cost.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

const SIZED = {
    'Iterator toArray': (n) => `var a=new Array(${n}).fill(1);a.values().toArray();return 1;`,
    'Iterator drop': (n) => `var a=new Array(${n}).fill(1);a.values().drop(${n - 1}).next();return 1;`,
    'String isWellFormed': (n) => `var s='x'.repeat(${n});s.isWellFormed();return 1;`,
    'String toWellFormed': (n) => `var s='x'.repeat(${n});s.toWellFormed();return 1;`,
    'Function apply': (n) => `var a=new Array(${n}).fill(1);Math.max.apply(null,a);return 1;`,
    'Function apply array-like': (n) => `Math.max.apply(null,{length:${n}});return 1;`,
    'Set union': (n) => `var x=new Set(),y=new Set();for(var j=0;j<${n};j++){x.add(j);}x.union(y);return 1;`,
    'Set isSubsetOf': (n) => `var x=new Set(),y=new Set();for(var j=0;j<${n};j++){y.add(j);}x.isSubsetOf(y);return 1;`,
};

(XChainVM ? describe : describe.skip)('native builtin meter charge shape', function () {
    this.timeout(60000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 100000000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (network, body) => execute(vm, wrap(body), { method: 'default', network, blockContext: LATE });
    const surcharge = async (make, n) => {
        const armed = await run('regtest', make(n));
        const legacy = await run('mainnet', make(n));
        assert.strictEqual(armed.success, true, armed.error);
        assert.strictEqual(legacy.success, true, legacy.error);
        return armed.gasUsed - legacy.gasUsed;
    };

    for (const id of Object.keys(SIZED)) {
        it(`${id}: the armed surcharge grows with the operand`, async function () {
            const small = await surcharge(SIZED[id], 2000);
            const large = await surcharge(SIZED[id], 8000);
            assert.ok(small >= 1900, `${id}: small surcharge ${small}`);
            assert.ok(large >= 7900, `${id}: large surcharge ${large}`);
            assert.ok(large - small >= 5900, `${id}: ${small} -> ${large} is not linear in the operand`);
        });
    }

    it('a short apply argument list keeps the legacy cost on an armed network', async function () {
        const body = `var a=[1,2,3];return Math.max.apply(null,a);`;
        const baseline = `return Math.max(1,2,3);`;
        const armed = await run('regtest', body);
        const legacy = await run('mainnet', body);
        const armedBaseline = await run('regtest', baseline);
        const legacyBaseline = await run('mainnet', baseline);
        assert.strictEqual(armed.gasUsed - legacy.gasUsed,
            armedBaseline.gasUsed - legacyBaseline.gasUsed);
    });

    it('apply keeps its result and this-binding once metered', async function () {
        const body = `var o={k:4};function f(a,b){return this.k+a+b;}return f.apply(o,[1,2]);`;
        const armed = await run('regtest', body);
        const legacy = await run('mainnet', body);
        assert.strictEqual(armed.success, true, armed.error);
        assert.deepStrictEqual(armed.result, legacy.result);
    });

    it('the armed methods return the same values as the unarmed ones', async function () {
        const body = `var x=new Set([1,2,3]),y=new Set([2,3,4]);` +
            `return JSON.stringify([[...x.union(y)],[...x.intersection(y)],[...x.difference(y)],` +
            `[...x.symmetricDifference(y)],x.isSubsetOf(y),x.isSupersetOf(y),x.isDisjointFrom(y),` +
            `'a\\uD800'.isWellFormed(),'a\\uD800'.toWellFormed().length,[5,6,7].values().drop(1).toArray()]);`;
        const armed = await run('regtest', body);
        const legacy = await run('mainnet', body);
        assert.strictEqual(armed.success, true, armed.error);
        assert.strictEqual(armed.result, legacy.result);
    });
});
