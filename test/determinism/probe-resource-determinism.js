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
 * Resource-outcome determinism probe.
 *
 * Runs each resource-ceiling contract N times ON THIS MACHINE and reports
 * how many DISTINCT (error-class, gasUsed) outcomes it produced. A
 * gas/count-bounded ceiling should yield exactly ONE outcome across all
 * runs. A wall-clock / memory ceiling that produces >1 distinct outcome
 * on a SINGLE machine is proof-positive of consensus-relevant
 * nondeterminism (it will only be worse across heterogeneous validators).
 *
 *   node test/determinism/probe-resource-determinism.js [runs=15]
 ********************************************************************/
// @ts-nocheck


const { createVM, execute } = require('../fuzz/harness');
const { SCENARIOS, BLOCK } = require('./scenarios');

const RUNS = parseInt(process.argv[2] || '15', 10);

function errorClass(err) {
    if (!err) return 'ok';
    return String(err).split(':')[0].trim();
}

async function probe(sc) {
    const outcomes = new Map(); // key: `${class}|${gasUsed}` -> count
    for (let i = 0; i < RUNS; i++) {
        const vm = createVM();
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        const r = await execute(vm, sc.code, {
            method: sc.method, params: sc.params, state: sc.state || {},
            blockContext: BLOCK, contractIndex: 1
        });
        if (typeof vm.endBlock === 'function') vm.endBlock();
        const key = `${errorClass(r.error)}|gas=${r.gasUsed}`;
        outcomes.set(key, (outcomes.get(key) || 0) + 1);
    }
    return outcomes;
}

async function main() {
    const resourceScenarios = SCENARIOS.filter(s => s.tier === 'resource');
    process.stdout.write(`Resource determinism probe: ${RUNS} runs each on this machine\n`);
    process.stdout.write(`${'-'.repeat(72)}\n`);
    let anyNondeterministic = false;
    for (const sc of resourceScenarios) {
        const outcomes = await probe(sc);
        const distinct = outcomes.size;
        const verdict = distinct === 1 ? 'DETERMINISTIC' : 'NON-DETERMINISTIC ***';
        if (distinct > 1) anyNondeterministic = true;
        process.stdout.write(`\n${sc.id}  [${sc.hazard || 'bounded'}]\n`);
        process.stdout.write(`  ${distinct} distinct outcome(s) → ${verdict}\n`);
        for (const [k, n] of [...outcomes.entries()].sort()) {
            process.stdout.write(`    ${String(n).padStart(3)}x  ${k}\n`);
        }
    }
    process.stdout.write(`\n${'-'.repeat(72)}\n`);
    process.stdout.write(anyNondeterministic
        ? 'RESULT: at least one resource ceiling is NON-DETERMINISTIC on a single machine.\n'
        : 'RESULT: all resource ceilings deterministic on this machine.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
