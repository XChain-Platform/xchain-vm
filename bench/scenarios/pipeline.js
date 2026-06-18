#!/usr/bin/env node
// @ts-nocheck
// 
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
 * Pipeline Microbenchmarks
 *
 * Measures each stage of the VM execution pipeline:
 *   1. Full execute() end-to-end (cache miss)
 *   2. Full execute() end-to-end (cache hit, within a block)
 *   3. Metering (AST parse + injection + codegen)
 *   4. Sandbox + gateway overhead (estimated from trivial vs no-op delta)
 *
 * Runs each tier (trivial, light, medium, heavy) for N iterations
 * after a warmup phase.
 ********************************************************************/

const { performance } = require('perf_hooks');
const {
    createVM, createContext, loadContract,
    measure, collectStats, memSnapshot, printTable, printMemory
} = require('../harness.js');
const { meterCode } = require('../../src/metering.js');

const ITERATIONS = 100;
const WARMUP     = 10;

const TIERS = [
    { name: 'trivial', file: 'trivial.js' },
    { name: 'light',   file: 'light.js' },
    { name: 'medium',  file: 'medium.js' },
    { name: 'heavy',   file: 'heavy.js' }
];

async function benchmarkMeteringStage() {
    const rows = [];
    for (const tier of TIERS) {
        const code = loadContract(tier.file);
        const timings = [];
        // Warmup
        for (let i = 0; i < WARMUP; i++) meterCode(code);
        // Measured
        for (let i = 0; i < ITERATIONS; i++) {
            const start = performance.now();
            meterCode(code);
            timings.push(performance.now() - start);
        }
        rows.push({ label: 'metering/' + tier.name, stats: collectStats(timings) });
    }
    return rows;
}

async function benchmarkExecuteCacheMiss() {
    const vm   = createVM();
    const rows = [];

    for (const tier of TIERS) {
        const code = loadContract(tier.file);
        const ctx  = createContext();

        const timings = await measure(async () => {
            // No beginBlock: every call is a cache miss
            const result = await vm.execute({ code, ...ctx });
            if (!result.success && !result.error.startsWith('out_of_gas')) {
                throw new Error('Unexpected failure: ' + result.error);
            }
        }, ITERATIONS, WARMUP);

        rows.push({ label: 'execute-cold/' + tier.name, stats: collectStats(timings) });
    }
    return rows;
}

async function benchmarkExecuteCacheHit() {
    const vm   = createVM();
    const rows = [];

    for (const tier of TIERS) {
        const code = loadContract(tier.file);
        const ctx  = createContext();

        vm.beginBlock();
        // Prime the cache with one execution
        await vm.execute({ code, ...ctx });

        const timings = await measure(async () => {
            const result = await vm.execute({ code, ...ctx });
            if (!result.success && !result.error.startsWith('out_of_gas')) {
                throw new Error('Unexpected failure: ' + result.error);
            }
        }, ITERATIONS, WARMUP);

        vm.endBlock();
        rows.push({ label: 'execute-warm/' + tier.name, stats: collectStats(timings) });
    }
    return rows;
}

async function benchmarkStressContracts() {
    const vm   = createVM({ gasCeiling: 50000000 });
    const rows = [];

    const stressContracts = [
        { name: 'state_heavy', file: 'stress/state_heavy.js' },
        { name: 'math_heavy',  file: 'stress/math_heavy.js' }
    ];

    for (const sc of stressContracts) {
        const code = loadContract(sc.file);
        const ctx  = createContext();

        const timings = await measure(async () => {
            await vm.execute({ code, ...ctx });
        }, 20, 3);

        rows.push({ label: 'stress/' + sc.name, stats: collectStats(timings) });
    }

    // Gas burner: expect it to hit gas ceiling; measure time-to-terminate
    const burnerVM   = createVM({ gasCeiling: 100000 });
    const burnerCode = loadContract('stress/gas_burner.js');
    const burnerCtx  = createContext();
    const burnerTimings = await measure(async () => {
        await burnerVM.execute({ code: burnerCode, ...burnerCtx });
        // Expected: out_of_gas
    }, 20, 3);
    rows.push({ label: 'stress/gas_burner', stats: collectStats(burnerTimings) });

    return rows;
}

async function main() {
    console.log('XChain VM Pipeline Microbenchmarks');
    console.log('Node ' + process.version + ' | ' + process.platform + '-' + process.arch);
    console.log('Iterations: ' + ITERATIONS + ' | Warmup: ' + WARMUP);

    const memBefore = memSnapshot();

    const meteringRows  = await benchmarkMeteringStage();
    const coldRows      = await benchmarkExecuteCacheMiss();
    const warmRows      = await benchmarkExecuteCacheHit();
    const stressRows    = await benchmarkStressContracts();

    printTable('Metering (AST parse + inject + codegen)', meteringRows);
    printTable('Execute: Cache Miss (cold)', coldRows);
    printTable('Execute: Cache Hit (warm)', warmRows);
    printTable('Stress Contracts', stressRows);

    // Cache speedup summary
    console.log('\n  Cache Speedup (cold mean / warm mean):');
    for (let i = 0; i < TIERS.length; i++) {
        const cold = coldRows[i].stats.mean;
        const warm = warmRows[i].stats.mean;
        const speedup = cold / warm;
        console.log('    ' + TIERS[i].name.padEnd(12) + ': ' + speedup.toFixed(2) + 'x faster with cache');
    }

    const memAfter = memSnapshot();
    printMemory(memBefore, memAfter);

    console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
