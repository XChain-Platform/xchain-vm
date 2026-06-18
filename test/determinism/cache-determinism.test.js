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
 * Determinism guard: per-block compilation cache must not change behavior.
 *
 * The VM caches V8 cachedData per block (key contractIndex:sha256(code)). The
 * first execute compiles cold and stores cachedData; later executes of the same
 * contract in the same block compile WARM. A warm execution that diverged from
 * a cold one (gasUsed, returnValue, state, emissions) would fork validators
 * that hit the cache at different points. This guard asserts byte-identical
 * results across cold / warm / fresh-VM / different-contractIndex.
 *
 * In ci via the test/determinism/**.test.js glob. Evidence:
 * test/determinism/probe-compilation-cache-determinism.js.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, hashResult } = require('../fuzz/harness');

const CONTRACTS = {
    compute:  `module.exports = function(x){ var a=[]; for(var i=0;i<40;i++)a.push((i*7)%13); a.sort(); return a.indexOf(5)+':'+a.join(','); }`,
    stateful: `module.exports = function(x){ var n=Number(x.state.get('c')||'0'); x.state.set('c', String(n+1)); x.emit.send({destination:'BTC:a',tick:'T',quantity:'1'}); return 'n='+n; }`,
    branchy:  `module.exports = function(x){ var s=0; for(var i=0;i<30;i++){ if(i%2){ s+=i; } else if(i%3){ s-=1; } else { s*=2; } } try { return String(s); } catch(e){ return 'e'; } }`
};
const BASE = { method: 'default', state: { c: '5' }, contractIndex: 7 };
const run = (vm, code, extra) => execute(vm, code, Object.assign({}, BASE, extra));

(createVM ? describe : describe.skip)('compilation-cache determinism', function () {
    this.timeout(30000);

    for (const [name, code] of Object.entries(CONTRACTS)) {
        it(`${name}: warm-cache result is byte-identical to cold`, async function () {
            const vm = createVM();
            vm.beginBlock();
            const cold = hashResult(await run(vm, code));   // compiles cold, stores cachedData
            const warm1 = hashResult(await run(vm, code));  // compiles warm
            const warm2 = hashResult(await run(vm, code));
            vm.endBlock();

            const vm2 = createVM();
            vm2.beginBlock();
            const freshCold = hashResult(await run(vm2, code));
            vm2.endBlock();

            assert.strictEqual(warm1, cold, `${name}: warm1 != cold (cache changed behavior)`);
            assert.strictEqual(warm2, cold, `${name}: warm2 != cold`);
            assert.strictEqual(freshCold, cold, `${name}: fresh-VM cold != warm (cross-validator divergence)`);
        });
    }

    it('same code at different contractIndex does not bleed cachedData', async function () {
        const code = CONTRACTS.compute;
        const vm = createVM();
        vm.beginBlock();
        const idxA = hashResult(await run(vm, code, { contractIndex: 1 }));
        const idxB = hashResult(await run(vm, code, { contractIndex: 2 }));
        vm.endBlock();
        assert.strictEqual(idxA, idxB, 'same code+state at different index must produce identical results');
    });
});
