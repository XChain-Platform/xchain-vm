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
 * Red-team: metering-completeness sweep.
 *
 * Generalizes the G1 compute-amplification probe across a broad list of
 * native builtins that do O(n) work without a per-element JS callback, to
 * find any that are STILL charged ~1 gas regardless of input size. Methods
 * that take a callback (map/filter/reduce/forEach/some/every/find/flatMap)
 * are metered by the callback body and are excluded.
 *
 * Method: CALL-SWEEP. Build ONE working set of fixed size K (so allocation
 * gas is constant and cancels), then perform C native operations over it.
 * Each op touches ~K elements. A faithful meter charges ~K gas per op, so
 * "touches/gas" = added native work per added gas stays small. >> 1 means
 * the builtin's native work is un-metered.
 *
 *   node test/determinism/probe-metering-completeness.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute } = require('../fuzz/harness');

const GAS_CEILING = 80000000;
const CPU_MS      = 30000;
const K           = 20000;    // working-set size (kept small: a large K-key object
                              // + Object.keys can exceed the 8 MB isolate limit and,
                              // in-process, trip the host-abort OOM path)
const LOW         = 1;
const HIGH        = 500;

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

// Each entry: setup builds the fixed working set; op(C) runs C native ops.
// `arr` = `var a=new Array(K).fill(7);`  `obj` = object with K keys.
const ARR = `var a=new Array(${K}).fill(7);`;
const OBJ = `var o={};for(var j=0;j<${K};j++)o['k'+j]=j;`;
const STR = `var s=('7,').repeat(${K});`;
// A K-char string of a single valid URI/numeric char, for the global-function
// vectors (encode/decode/escape/parse). '5' is identity under encode/escape and
// a legal parseInt/parseFloat body, so the op work is O(len) with no throw.
const GSTR = `var s=('5').repeat(${K});`;
// The F3-globals metering (like F3-binary) is flag-day-gated on block time, so
// these vectors must run AT/ABOVE the gate to exercise the ACTIVATED ruleset;
// below it they are intentionally un-metered (historical replay behaviour).
const POST_GATE_BLOCK = { height: 100, timestamp: 1798761600, hash: 'gate' };

const VECTORS = [
    // --- Array methods G1 should already cover (regression) ---
    { id: 'Array.indexOf',   mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.indexOf(-1);return t;` },
    { id: 'Array.join',      mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.join(',').length;return t;` },
    { id: 'Array.sort',      mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++){a.sort();t+=a[0];}return t;` },
    // --- Array mutators / ES2023 copies NOT in the original G1 list (suspect) ---
    { id: 'Array.splice',    mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++){a.splice(0,0,1);t+=a.length;}return t;` },
    { id: 'Array.unshift',   mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.unshift(1);return t;` },
    { id: 'Array.shift',     mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=(a.shift()||0);return t;` },
    { id: 'Array.toSorted',  mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.toSorted().length;return t;` },
    { id: 'Array.toReversed',mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.toReversed().length;return t;` },
    { id: 'Array.with',      mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=a.with(0,9).length;return t;` },
    // --- Object statics over a K-key object (suspect) ---
    { id: 'Object.keys',     mk: C => `${OBJ}var t=0;for(var i=0;i<${C};i++)t+=Object.keys(o).length;return t;` },
    { id: 'Object.values',   mk: C => `${OBJ}var t=0;for(var i=0;i<${C};i++)t+=Object.values(o).length;return t;` },
    { id: 'Object.entries',  mk: C => `${OBJ}var t=0;for(var i=0;i<${C};i++)t+=Object.entries(o).length;return t;` },
    { id: 'Object.assign',   mk: C => `${OBJ}var t=0;for(var i=0;i<${C};i++)t+=Object.keys(Object.assign({},o)).length;return t;` },
    { id: 'Object.getOwnPropertyNames', mk: C => `${OBJ}var t=0;for(var i=0;i<${C};i++)t+=Object.getOwnPropertyNames(o).length;return t;` },
    // --- Spread (syntax, like `+`, not a method) ---
    { id: 'spread [...array]',  mk: C => `${ARR}var t=0;for(var i=0;i<${C};i++)t+=[].concat(a).length;return t;` }, // baseline via concat (metered)
    { id: 'spread [...string]', mk: C => `${STR}var t=0;for(var i=0;i<${C};i++)t+=([...s]).length;return t;` },
    // --- O(n) GLOBAL functions, flag-day-gated (F3-globals). Run POST-gate. ---
    { id: 'encodeURIComponent', gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=encodeURIComponent(s).length;return t;` },
    { id: 'decodeURIComponent', gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=decodeURIComponent(s).length;return t;` },
    { id: 'encodeURI',          gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=encodeURI(s).length;return t;` },
    { id: 'escape',             gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=escape(s).length;return t;` },
    { id: 'unescape',           gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=unescape(s).length;return t;` },
    { id: 'parseInt',           gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=(parseInt(s,10)>0?1:0);return t;` },
    { id: 'parseFloat',         gated: true, mk: C => `${GSTR}var t=0;for(var i=0;i<${C};i++)t+=(parseFloat(s)>0?1:0);return t;` }
];

async function run(code, blockContext) {
    const vm = createVM({ gasCeiling: GAS_CEILING, maxCpuTimeMs: CPU_MS });
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    let r;
    try { r = await execute(vm, code, { method: 'default', blockContext: blockContext }); }
    catch (e) { r = { success: false, error: 'THROW: ' + e.message, gasUsed: -1 }; }
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

async function main() {
    process.stdout.write(`Metering-completeness sweep (K=${K}, calls ${LOW}->${HIGH})\n${'='.repeat(80)}\n`);
    process.stdout.write(`${'builtin'.padEnd(34)} ${'dGas'.padStart(10)} ${'touches/gas'.padStart(12)}  verdict\n`);
    process.stdout.write(`${'-'.repeat(80)}\n`);
    const findings = [];
    for (const v of VECTORS) {
        const bc = v.gated ? POST_GATE_BLOCK : undefined;
        const lo = await run(wrap(v.mk(LOW)), bc);
        const hi = await run(wrap(v.mk(HIGH)), bc);
        let verdict, tpg = '';
        const oog = /out_of_gas/.test(lo.error || '') || /out_of_gas/.test(hi.error || '');
        if (oog || hi.gasUsed >= GAS_CEILING || lo.gasUsed >= GAS_CEILING) {
            verdict = 'METERED (clamped out_of_gas)';
        } else if (!lo.success || !hi.success) {
            verdict = `unavailable/err (${String(lo.error || hi.error).split(':')[0]})`;
        } else {
            const dgas = hi.gasUsed - lo.gasUsed;
            const ratio = dgas > 0 ? Math.round(((HIGH - LOW) * K) / dgas) : Infinity;
            tpg = String(ratio);
            if (ratio >= 1000) { verdict = '*** UN-METERED'; findings.push(`${v.id} (~${ratio} touches/gas)`); }
            else verdict = 'metered';
        }
        const dgas = (lo.success && hi.success) ? (hi.gasUsed - lo.gasUsed) : 0;
        process.stdout.write(`${v.id.padEnd(34)} ${String(dgas).padStart(10)} ${tpg.padStart(12)}  ${verdict}\n`);
    }
    process.stdout.write(`\n${'='.repeat(80)}\n`);
    process.stdout.write(findings.length
        ? `FINDINGS (${findings.length} un-metered):\n  - ${findings.join('\n  - ')}\n`
        : 'No un-metered builtin detected.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
