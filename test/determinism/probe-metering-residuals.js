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
 * Red-team: documented metering-completeness residuals (handover item #6).
 *
 * The G4 syntax-allocator metering (src/metering.js transformAllocators)
 * charges `+` / `+=` / template literals / array+object spread by bytes/elements
 * grown, so the GAS ceiling (not the host memory/wall-clock backstop) is the
 * binding constraint. A few constructs are NOT rewritten and so escape the byte
 * charge:
 *   - `+=` with a COMPUTED or COMPLEX LHS (obj[k] += , a.b.c += ): only a
 *     simple identifier / non-computed member is rewritten (_isSimpleAppendTarget).
 *   - TAGGED template quasis (tag`...`): deliberately skipped.
 *   - object spread mixed with accessors/methods.
 *   - call spread f(...x): bounded by V8's arg-count limit.
 *
 * This probe CLASSIFIES each, RED-first, so the exposure is concrete:
 *   GAS-BOUND   (best): the work trips out_of_gas; gas is the binding constraint.
 *   CONTAINED   (ok):   it trips the memory/host backstop (out_of_resource); the
 *                       contract is still contained + deterministically failed, but
 *                       gas was NOT the binding constraint (the F-series ideal).
 *   CHEAP-ESCAPE(BAD):  it COMPLETES cheaply: O(n) work for O(1) gas, a real
 *                       cheap-gas/expensive-CPU hole.
 *
 *   node test/determinism/probe-metering-residuals.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute, consensusError } = require('../fuzz/harness');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

// Each vector tries to build an enormous string / do O(n) work via a construct
// the meter may not byte-charge. DOUBLING (x = x + x) is the sharp test: 30
// doublings is ~1e9 bytes; if it completes or only memory-faults, gas was not
// the binding constraint.
const N = 40;
const VECTORS = [
    { id: 'simple-LHS doubling (baseline, should be GAS-BOUND by G4)',
      code: wrap(`var s='x'; for(var i=0;i<${N};i++){ s += s; } return s.length;`) },
    { id: 'computed-LHS doubling  o["k"] += o["k"]',
      code: wrap(`var o={k:'x'}; for(var i=0;i<${N};i++){ o["k"] += o["k"]; } return o["k"].length;`) },
    { id: 'complex-LHS doubling   o.a.b += o.a.b',
      code: wrap(`var o={a:{b:'x'}}; for(var i=0;i<${N};i++){ o.a.b += o.a.b; } return o.a.b.length;`) },
    { id: 'tagged-template build  String.raw`...${s}...`',
      code: wrap(`var s='x'; for(var i=0;i<${N};i++){ s = String.raw\`\${s}\${s}\`; } return s.length;`) },
    { id: 'call-spread f(...big)  (expected: bounded by V8 arg limit)',
      code: wrap(`var a=[]; for(var i=0;i<200000;i++) a.push(i); function f(){ return arguments.length; } var t=0; for(var i=0;i<50;i++){ t += f(...a); } return t;`) }
];

function classify(r) {
    if (r.success === true) return 'CHEAP-ESCAPE *** (O(n) work for O(1) gas)';
    const status = consensusError(r.error);
    if (/^out_of_gas/.test(String(r.error))) return 'GAS-BOUND (ideal)';
    if (status === 'out_of_resource') return 'CONTAINED (memory/host backstop; gas NOT binding)';
    return 'failed: ' + JSON.stringify(r.error);
}

async function run(code) {
    // Generous wall-clock net so the classification reflects the GAS vs MEMORY
    // backstop (not a spurious wall-clock timeout under CPU load). 1M gas / 8 MB.
    const vm = createVM({ maxCpuTimeMs: 30000 });
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    let r;
    try { r = await execute(vm, code, { method: 'default' }); }
    catch (e) { r = { success: false, error: 'THROW: ' + (e && e.message) }; }
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

async function main() {
    process.stdout.write(`Metering-completeness residuals (item #6)\n${'='.repeat(78)}\n`);
    const findings = [];
    for (const v of VECTORS) {
        const r = await run(v.code);
        const verdict = classify(r);
        if (/CHEAP-ESCAPE/.test(verdict)) findings.push(v.id);
        process.stdout.write(`\n${v.id}\n  → ${verdict}\n` +
            `  success=${r.success} gasUsed=${r.gasUsed} error=${JSON.stringify(r.error)}\n`);
    }
    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(findings.length
        ? `CHEAP-ESCAPE findings (${findings.length}), real cheap-gas holes:\n  - ${findings.join('\n  - ')}\n`
        : `No cheap-escape: every residual is at least CONTAINED (gas- or memory-bounded).\n`);
    process.exit(findings.length ? 2 : 0);
}

main().catch(e => { process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
