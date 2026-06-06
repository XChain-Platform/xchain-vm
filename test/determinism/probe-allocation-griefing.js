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
 * Red-team: un-metered allocation / compute griefing.
 *
 * AST gas metering charges per __gas() injection point (function entry,
 * loop body, call site, conditional, deep binary expr). A SINGLE builtin
 * call that allocates or computes a huge amount — 'x'.repeat(2e9),
 * Array(n).fill(), padStart(1e9), deep recursion — passes ONE call site
 * (~1 gas) yet consumes unbounded host memory / CPU. The only backstops
 * are the memory ceiling and the WALL-CLOCK timeout, both of which can
 * fire at machine-/GC-/stack-depth-dependent points.
 *
 * For each vector this probe runs N times and reports whether the
 * (error-class, gasUsed) outcome is DETERMINISTIC. Any vector that
 * resolves via a nondeterministic ceiling is a consensus-split candidate
 * (gasUsed feeds fee math — see report), not merely a DoS.
 *
 *   node test/determinism/probe-allocation-griefing.js [runs=8]
 ********************************************************************/

const { createVM, execute } = require('../fuzz/harness');

const RUNS = parseInt(process.argv[2] || '8', 10);

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

const VECTORS = [
    { id: 'string.repeat(2e9)',        code: wrap(`var s = 'x'.repeat(2000000000); return s.length;`) },
    { id: 'string.padStart(1e9)',      code: wrap(`var s = 'ab'.padStart(1000000000, 'x'); return s.length;`) },
    { id: 'Array(1e8).fill(x)',        code: wrap(`var a = new Array(100000000).fill('x'); return a.length;`) },
    { id: 'Array.from(length 1e8)',    code: wrap(`var a = Array.from({length: 100000000}); return a.length;`) },
    { id: 'spread Array(1e7)',         code: wrap(`var a = [...new Array(10000000)]; return a.length;`) },
    { id: 'deep recursion (stack)',    code: wrap(`function f(n){ return f(n+1); } return f(0);`) },
    { id: 'JSON.stringify huge',       code: wrap(`var a = new Array(5000000).fill(0).map(function(_,i){return i;}); return JSON.stringify(a).length;`) },
    { id: 'string concat doubling',    code: wrap(`var s = 'x'; for (var i=0;i<60;i++){ s = s + s; } return s.length;`) }
];

function errorClass(err) {
    if (!err) return 'ok(SUCCESS!)';
    return String(err).split(':')[0].trim();
}

async function probe(v) {
    const outcomes = new Map();
    for (let i = 0; i < RUNS; i++) {
        const vm = createVM();
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        let r;
        try {
            r = await execute(vm, v.code, { method: 'default' });
        } catch (e) {
            r = { success: false, error: 'HARNESS_THROW: ' + e.message, gasUsed: -1 };
        }
        if (typeof vm.endBlock === 'function') vm.endBlock();
        const key = `${errorClass(r.error)} | gas=${r.gasUsed}`;
        outcomes.set(key, (outcomes.get(key) || 0) + 1);
    }
    return outcomes;
}

async function main() {
    // Single-vector mode: `--vector N` runs exactly one vector once, in this
    // process, so a HARD HOST ABORT (core dump) is attributable to that vector
    // and cannot be masked by a later one. Exit 0 = contained, 99 = uncontained
    // success, signal/abort = host crash.
    const vi = process.argv.indexOf('--vector');
    if (vi !== -1) {
        const v = VECTORS[parseInt(process.argv[vi + 1], 10)];
        const vm = createVM();
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        const r = await execute(vm, v.code, { method: 'default' });
        if (typeof vm.endBlock === 'function') vm.endBlock();
        process.stdout.write(`${v.id} :: success=${r.success} gas=${r.gasUsed} error=${JSON.stringify(r.error)}\n`);
        process.exit(r.success ? 99 : 0);
    }

    process.stdout.write(`Allocation-griefing red-team probe — ${RUNS} runs/vector\n${'='.repeat(74)}\n`);
    const findings = [];
    for (const v of VECTORS) {
        const outcomes = await probe(v);
        const distinct = outcomes.size;
        const classes = new Set([...outcomes.keys()].map(k => k.split(' | ')[0]));
        const succeeded = [...classes].some(c => c.startsWith('ok'));
        let verdict;
        if (succeeded) verdict = 'UNCONTAINED (SUCCEEDED!) ***';
        else if (distinct === 1) verdict = 'deterministic / contained';
        else verdict = `NON-DETERMINISTIC (${distinct} outcomes) ***`;
        if (verdict.includes('***')) findings.push(v.id);
        process.stdout.write(`\n${v.id}\n  → ${verdict}\n`);
        for (const [k, n] of [...outcomes.entries()].sort()) {
            process.stdout.write(`     ${String(n).padStart(2)}x  ${k}\n`);
        }
    }
    process.stdout.write(`\n${'='.repeat(74)}\n`);
    process.stdout.write(findings.length
        ? `FINDINGS (${findings.length}): ${findings.join(', ')}\n`
        : 'All vectors deterministic & contained.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
