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
 * Red-team: native COMPUTE/ITERATION amplification (un-metered work).
 *
 * Finding F3 added size-proportional gas to the ALLOCATION builtins
 * (Array.prototype.fill, Array.from, String.prototype.repeat/padStart/
 * padEnd) so a single bulk allocation can no longer outrun the gas
 * ceiling. Two families are STILL charged ~1 gas regardless of size:
 *
 *   (1) Compute/iteration builtins: Array.prototype.sort/join/reverse/
 *       indexOf/includes/concat, String.prototype.split/indexOf/slice,
 *       JSON.parse/JSON.stringify. Each does O(n)…O(n log n) NATIVE work
 *       for one __gas(1) at the call site.
 *   (2) String concatenation via the `+` operator. `s = s + s` doubles
 *       the allocation every iteration; F3 wraps repeat/padStart/padEnd
 *       but NOT `+`, so a 21-iteration loop builds a multi-MB string for
 *       ~21 gas.
 *
 * Post-F1 a contract that overruns the wall-clock backstop resolves to a
 * deterministic `out_of_resource` (no fork), so this is a LIVENESS /
 * THROUGHPUT attack: a one-fee tx makes every validator grind to the
 * wall-clock net.
 *
 * ── How this probe proves it (two independent lenses) ──
 *
 *  A) CALL-SWEEP (timing-independent, the rigorous proof): hold the working
 *     set FIXED (so allocation gas is constant and cancels) and vary only
 *     the NUMBER of native calls over it. Each extra call does O(K) native
 *     work. A faithful meter would charge ~K gas per extra call; the meter
 *     charges ~1 (just the loop body). So "native element-touches per extra
 *     gas" ≈ K, i.e. one gas unit buys K units of native work.
 *
 *  B) WALL-CLOCK WITNESS: one combined vector (string-`+` build + split)
 *     reports gas spent vs. host CPU spent, to show the absolute scale.
 *
 *   node test/determinism/probe-compute-amplification.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute } = require('../fuzz/harness');

const GAS_CEILING = 80000000; // 80M, generous so the work completes & is measurable
const CPU_MS      = 30000;    // 30s wall-clock net
const K           = 200000;   // FIXED working-set size (allocation cost held constant)
const LOW         = 1;        // call counts swept while K is held fixed
const HIGH        = 2000;

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

async function run(code) {
    const vm = createVM({ gasCeiling: GAS_CEILING, maxCpuTimeMs: CPU_MS });
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const t0 = process.hrtime.bigint();
    let r;
    try {
        r = await execute(vm, code, { method: 'default' });
    } catch (e) {
        r = { success: false, error: 'HARNESS_THROW: ' + e.message, gasUsed: -1 };
    }
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return { gas: r.gasUsed, ok: r.success, err: r.error, wallMs };
}

// ── A) CALL-SWEEP VECTORS ───────────────────────────────────────────────
// mk(C) builds a contract that allocates ONE working set of fixed size K
// (constant gas) and then performs C native operations over it. We compare
// C=LOW vs C=HIGH. Each added call does ~K native element-touches; the gas
// delta should be ~(HIGH-LOW)*K for a faithful meter, but is ~(HIGH-LOW).
const DIFF = [
    { id: 'Array.indexOf (absent)',
      mk: C => `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)c+=a.indexOf(-1);return c;` },
    { id: 'Array.includes (absent)',
      mk: C => `var a=new Array(${K}).fill(7);var c=0;for(var i=0;i<${C};i++)if(a.includes(-1))c++;return c;` },
    { id: 'Array.join',
      mk: C => `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=a.join(',').length;return t;` },
    { id: 'Array.sort (default)',
      mk: C => `var a=new Array(${K}).fill(0);for(var i=0;i<${K};i++)a[i]=(i*2654435761)%1000003;var t=0;for(var i=0;i<${C};i++){a.sort();t+=a[0];}return t;` },
    { id: 'JSON.stringify',
      mk: C => `var a=new Array(${K}).fill(7);var t=0;for(var i=0;i<${C};i++)t+=JSON.stringify(a).length;return t;` },
    { id: 'String.split',
      mk: C => `var s=('7,').repeat(${K});var t=0;for(var i=0;i<${C};i++)t+=s.split(',').length;return t;` }
];

async function main() {
    process.stdout.write(`Native compute-amplification probe\n${'='.repeat(82)}\n`);
    process.stdout.write(`A) CALL-SWEEP: working set FIXED at K=${K}; vary native calls ${LOW} -> ${HIGH}.\n`);
    process.stdout.write(`   Each added call touches ~K elements. Faithful meter => dGas ~= dCalls*K.\n`);
    process.stdout.write(`   "touches/gas" = added native work per added gas. >>1 => UN-METERED.\n`);
    process.stdout.write(`${'-'.repeat(82)}\n`);
    process.stdout.write(`${'builtin'.padEnd(24)} ${'gas(C=' + LOW + ')'.padStart(11)} ${'gas(C=' + HIGH + ')'.padStart(12)} ${'dGas'.padStart(7)} ${'touches/gas'.padStart(12)}\n`);

    const findings = [];
    for (const v of DIFF) {
        const lo = await run(wrap(v.mk(LOW)));
        const hi = await run(wrap(v.mk(HIGH)));
        const dgas = hi.gas - lo.gas;
        const clamped = (lo.gas >= GAS_CEILING) || (hi.gas >= GAS_CEILING) || !lo.ok || !hi.ok;
        const addedWork = (HIGH - LOW) * K;            // native element-touches added
        const touchesPerGas = dgas > 0 ? Math.round(addedWork / dgas) : Infinity;
        // Un-metered if each added O(K) call cost roughly one gas (touches/gas ~ K).
        const unmetered = !clamped && touchesPerGas >= 1000;
        if (unmetered) findings.push(`${v.id} (~${touchesPerGas} native touches per gas)`);
        process.stdout.write(
            `${v.id.padEnd(24)} ${String(lo.gas).padStart(11)} ${String(hi.gas).padStart(12)} ` +
            `${String(dgas).padStart(7)} ${String(touchesPerGas).padStart(12)}` +
            `${unmetered ? '   *** UN-METERED' : clamped ? '   [clamped/err]' : ''}\n`
        );
    }

    // ── B) WALL-CLOCK WITNESS ───────────────────────────────────────────
    process.stdout.write(`\nB) WALL-CLOCK WITNESS: string-'+' build + split, gas spent vs CPU spent\n`);
    process.stdout.write(`${'-'.repeat(82)}\n`);
    const witness = wrap(`var s='7';for(var i=0;i<21;i++)s=s+','+s;var t=0;for(var i=0;i<200;i++)t+=s.split(',').length;return t;`);
    const w = await run(witness);
    const amp = (w.wallMs * 1000) / (Math.max(w.gas, 1)); // µs of CPU per gas
    process.stdout.write(`  gas=${w.gas}  wallMs=${w.wallMs.toFixed(1)}  =>  ${amp.toFixed(1)} us of host CPU per gas unit\n`);
    if (w.ok && w.gas < 100000 && w.wallMs > 1000) {
        findings.push(`string-'+'/split witness (${w.gas} gas bought ${w.wallMs.toFixed(0)} ms CPU)`);
    }

    process.stdout.write(`\n${'='.repeat(82)}\n`);
    process.stdout.write(findings.length
        ? `FINDINGS (${findings.length}):\n  - ${findings.join('\n  - ')}\n`
        : 'No un-metered compute builtin detected.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
