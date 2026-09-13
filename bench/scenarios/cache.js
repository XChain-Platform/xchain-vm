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
 * Compilation Cache Effectiveness Benchmark
 *
 * Measures the VM compilation cache impact by varying hit rates:
 *   - 0%   hit rate: every contract is unique (all cache misses)
 *   - 50%  hit rate: half the contracts repeat
 *   - 100% hit rate: same contract every time
 *
 * Also measures cache memory footprint and lookup overhead.
 ********************************************************************/

const { performance } = require('perf_hooks');
const {
    createVM, createContext, loadContract,
    collectStats, memSnapshot, printTable, printMemory, fmt
} = require('../harness.js');

const BLOCK_SIZE = 100;
const BLOCKS     = 5;

// Generate unique contract variants by adding a comment
function makeUniqueVariant(baseCode, index) {
    return '// variant-' + index + '-' + Date.now() + '\n' + baseCode;
}

async function benchmarkHitRate(vm, baseCode, hitRate, label) {
    const blockTimings = [];

    for (let b = 0; b < BLOCKS; b++) {
        // Prepare contracts for this block
        const uniqueCount  = Math.round(BLOCK_SIZE * (1 - hitRate));
        const repeatedCode = baseCode;
        const uniqueCodes  = [];
        for (let i = 0; i < uniqueCount; i++) {
            uniqueCodes.push(makeUniqueVariant(baseCode, b * BLOCK_SIZE + i));
        }

        const perContractTimings = [];

        vm.beginBlock();
        for (let i = 0; i < BLOCK_SIZE; i++) {
            const code = (i < uniqueCount) ? uniqueCodes[i] : repeatedCode;
            const ctx = createContext({ contractIndex: i + 1 });

            const start = performance.now();
            const result = await vm.execute({ code, ...ctx });
            perContractTimings.push(performance.now() - start);

            if (!result.success) throw new Error('Failed: ' + result.error);
        }
        vm.endBlock();

        const blockTime = perContractTimings.reduce((a, b) => a + b, 0);
        blockTimings.push(blockTime);
    }

    const stats = collectStats(blockTimings);
    return { label, stats, meanBlockMs: stats.mean };
}

async function main() {
    console.log('XChain VM Compilation Cache Effectiveness');
    console.log('Node ' + process.version + ' | Block size: ' + BLOCK_SIZE + ' | Blocks: ' + BLOCKS);

    const baseCode = loadContract('medium.js');
    const vm = createVM();
    const memBefore = memSnapshot();

    const hitRates = [
        { rate: 0.00, label: '0% hit rate (all unique)' },
        { rate: 0.50, label: '50% hit rate' },
        { rate: 1.00, label: '100% hit rate (all same)' }
    ];

    const rows = [];
    const results = [];

    for (const { rate, label } of hitRates) {
        const result = await benchmarkHitRate(vm, baseCode, rate, label);
        results.push(result);
        rows.push({ label, stats: result.stats });

        console.log('  ' + label.padEnd(30) + ': ' +
            result.meanBlockMs.toFixed(0) + 'ms avg block time (' +
            BLOCK_SIZE + ' contracts)');
    }

    printTable('Block Time by Cache Hit Rate', rows);

    // Speedup analysis
    if (results.length >= 2) {
        const baseline = results[0].meanBlockMs; // 0% hit rate
        console.log('\n  Speedup vs 0% hit rate:');
        for (const r of results) {
            const speedup = baseline / r.meanBlockMs;
            console.log('    ' + r.label.padEnd(30) + ': ' + speedup.toFixed(2) + 'x');
        }
    }

    // Per-contract cost at each hit rate
    console.log('\n  Avg per-contract cost:');
    for (const r of results) {
        const perContract = r.meanBlockMs / BLOCK_SIZE;
        console.log('    ' + r.label.padEnd(30) + ': ' + fmt(perContract));
    }

    const memAfter = memSnapshot();
    printMemory(memBefore, memAfter);

    console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
