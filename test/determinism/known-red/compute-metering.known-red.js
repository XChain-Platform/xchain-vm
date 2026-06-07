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
 * Acceptance test (was KNOWN-RED) — native compute/iteration builtins
 * must be size-metered so the gas ceiling, not the wall-clock backstop,
 * is the binding constraint.
 *
 * RED before the G1 fix (the compute builtins were charged ~1 gas at the
 * call site regardless of input size — ~66,000 native element-touches per
 * gas, see probe), GREEN after `src/index.js` extends F3-style size
 * metering to them. Excluded from the green suites by the `.known-red.js`
 * suffix (the determinism globs match `*.test.js`). Run explicitly:
 *
 *     npm run test:known-red
 *
 * Invariant: a workload whose native element-touches exceed the gas budget
 * by >10x MUST terminate `out_of_gas` — it cannot run to completion. Each
 * vector below performs C * K = 10,000,000 native touches against a default
 * 1,000,000 gas ceiling. A generous 30 s wall-clock net is used so that,
 * BEFORE the fix, the work completes successfully (the RED state) rather
 * than being masked by a timeout.
 *
 * Evidence behind it: `test/determinism/probe-compute-amplification.js`.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/harness');

const CPU_MS = 30000;   // generous: pre-fix work completes (RED) instead of timing out
const K      = 200000;  // working-set size
const C      = 50;      // native calls; C*K = 10,000,000 touches vs the 1,000,000 ceiling

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

async function run(code) {
    const vm = createVM({ maxCpuTimeMs: CPU_MS }); // gas ceiling stays at the 1,000,000 default
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, code, { method: 'default' });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

function assertGasBounded(id, r) {
    assert(
        r.success === false && /out_of_gas/.test(r.error || ''),
        `${id}: ${C} x O(K=${K}) native ops (${C * K} element-touches, >10x the gas ceiling) ` +
        `resolved as success=${r.success} error=${JSON.stringify(r.error)} gasUsed=${r.gasUsed}. ` +
        `Native work must be gas-bounded (expected out_of_gas).`
    );
}

describe('compute builtins must be size-metered (was KNOWN-RED)', function () {
    this.timeout(180000);

    const BUILTINS = [
        { id: 'Array.prototype.indexOf',
          mk: `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)c+=a.indexOf(-1);return c;` },
        { id: 'Array.prototype.includes',
          mk: `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)if(a.includes(-1))c++;return c;` },
        { id: 'Array.prototype.join',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.join(',').length;return t;` },
        { id: 'Array.prototype.sort',
          mk: `var a=new Array(${K}).fill(0);for(var i=0;i<${K};i++)a[i]=(i*2654435761)%1000003;var t=0;for(var i=0;i<${C};i++){a.sort();t+=a[0];}return t;` },
        { id: 'JSON.stringify',
          mk: `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=JSON.stringify(a).length;return t;` },
        { id: 'String.prototype.split',
          mk: `var s=('7,').repeat(${K});var t=0;for(var i=0;i<${C};i++)t+=s.split(',').length;return t;` }
    ];

    for (const b of BUILTINS) {
        it(`${b.id}: O(n) native work must consume gas (out_of_gas under budget)`, async function () {
            assertGasBounded(b.id, await run(wrap(b.mk)));
        });
    }
});

describe('cheap-gas / expensive-CPU witness (was KNOWN-RED)', function () {
    this.timeout(60000);

    it('string-`+` build fed to split must be gas-bounded, not CPU-bounded', async function () {
        // ~21 `+` doublings build a ~2M-char string for ~tens of gas (the `+`
        // operator is not metered — bounded by the memory / max-string ceiling).
        // Pre-fix, split-ing it 200x burned >5 s of CPU for ~644 gas. Post-fix,
        // the first split charges ~2M gas and the work trips out_of_gas.
        const vm = createVM({ maxCpuTimeMs: CPU_MS });
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        const t0 = process.hrtime.bigint();
        const r = await execute(vm,
            wrap(`var s='7';for(var i=0;i<21;i++)s=s+','+s;var t=0;for(var i=0;i<200;i++)t+=s.split(',').length;return t;`),
            { method: 'default' });
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        if (typeof vm.endBlock === 'function') vm.endBlock();
        assert(
            r.success === false && /out_of_gas/.test(r.error || ''),
            `witness resolved as success=${r.success} error=${JSON.stringify(r.error)} ` +
            `gasUsed=${r.gasUsed} after ${wallMs.toFixed(0)} ms CPU. Expected out_of_gas.`
        );
    });
});
