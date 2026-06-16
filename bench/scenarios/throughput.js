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
 * Block Throughput Benchmark
 *
 * Simulates realistic block processing with mixed contract complexity:
 *   70% light, 20% medium, 10% heavy
 *
 * Tests block sizes: 50, 200, 1000 contracts.
 * Measures: contracts/sec, total block time, per-contract latency.
 * Compares with and without compilation cache (beginBlock/endBlock).
 ********************************************************************/

const { performance } = require('perf_hooks');
const {
    createVM, createContext, loadContract,
    collectStats, memSnapshot, printTable, printMemory, fmt
} = require('../harness.js');

const BLOCK_SIZES = [50, 200, 1000];
const BLOCKS_PER_SIZE = 5;

// Contract mix: 70/20/10
const CONTRACTS = {
    light:  { code: null, weight: 0.70 },
    medium: { code: null, weight: 0.20 },
    heavy:  { code: null, weight: 0.10 }
};

function buildBlockPlan(blockSize) {
    const plan = [];
    for (const [tier, conf] of Object.entries(CONTRACTS)) {
        const count = Math.round(blockSize * conf.weight);
        for (let i = 0; i < count; i++) plan.push(tier);
    }
    // Fill remainder with light
    while (plan.length < blockSize) plan.push('light');
    // Shuffle for realistic ordering
    for (let i = plan.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = plan[i]; plan[i] = plan[j]; plan[j] = tmp;
    }
    return plan;
}

async function benchmarkBlock(vm, blockSize, useCache) {
    const plan = buildBlockPlan(blockSize);
    const timings = [];
    let errors = 0;

    if (useCache) vm.beginBlock();

    const blockStart = performance.now();
    for (let i = 0; i < plan.length; i++) {
        const tier = plan[i];
        const code = CONTRACTS[tier].code;
        const ctx = createContext({ contractIndex: i + 1 });

        const start = performance.now();
        const result = await vm.execute({ code, ...ctx });
        timings.push(performance.now() - start);

        if (!result.success) errors++;
    }
    const blockTime = performance.now() - blockStart;

    if (useCache) vm.endBlock();

    const stats = collectStats(timings);
    const opsPerSec = (plan.length / (blockTime / 1000)).toFixed(1);

    return { blockSize, blockTime, opsPerSec, errors, stats };
}

async function main() {
    console.log('XChain VM Block Throughput Benchmark');
    console.log('Node ' + process.version + ' | Mix: 70% light / 20% medium / 10% heavy');
    console.log('Blocks per size: ' + BLOCKS_PER_SIZE);

    // Load contracts
    CONTRACTS.light.code  = loadContract('light.js');
    CONTRACTS.medium.code = loadContract('medium.js');
    CONTRACTS.heavy.code  = loadContract('heavy.js');

    const vm = createVM();
    const memBefore = memSnapshot();

    // --- With cache ---
    const cachedRows = [];
    console.log('\n  With compilation cache (beginBlock/endBlock):');
    for (const size of BLOCK_SIZES) {
        const blockResults = [];
        for (let b = 0; b < BLOCKS_PER_SIZE; b++) {
            blockResults.push(await benchmarkBlock(vm, size, true));
        }
        // Average across blocks
        const avgBlockTime = blockResults.reduce((s, r) => s + r.blockTime, 0) / BLOCKS_PER_SIZE;
        const avgOps = (size / (avgBlockTime / 1000)).toFixed(1);
        const allTimings = blockResults.flatMap(r => {
            // Reconstruct from stats — use the per-contract stats from last block
            return [];
        });
        const lastStats = blockResults[blockResults.length - 1].stats;
        const avgErrors = blockResults.reduce((s, r) => s + r.errors, 0) / BLOCKS_PER_SIZE;

        console.log('    Block/' + String(size).padEnd(5) + ': ' +
            avgBlockTime.toFixed(0) + 'ms total, ' +
            avgOps + ' ops/s, ' +
            'P99=' + fmt(lastStats.p99) + ', ' +
            'errors=' + avgErrors.toFixed(0));

        cachedRows.push({
            label: 'cached/block-' + size,
            stats: { ...lastStats, opsPerSec: avgOps, blockTimeMs: avgBlockTime.toFixed(0) }
        });
    }

    // --- Without cache ---
    const uncachedRows = [];
    console.log('\n  Without compilation cache (no beginBlock):');
    for (const size of BLOCK_SIZES) {
        const blockResults = [];
        for (let b = 0; b < BLOCKS_PER_SIZE; b++) {
            blockResults.push(await benchmarkBlock(vm, size, false));
        }
        const avgBlockTime = blockResults.reduce((s, r) => s + r.blockTime, 0) / BLOCKS_PER_SIZE;
        const avgOps = (size / (avgBlockTime / 1000)).toFixed(1);
        const lastStats = blockResults[blockResults.length - 1].stats;

        console.log('    Block/' + String(size).padEnd(5) + ': ' +
            avgBlockTime.toFixed(0) + 'ms total, ' +
            avgOps + ' ops/s, ' +
            'P99=' + fmt(lastStats.p99));

        uncachedRows.push({
            label: 'uncached/block-' + size,
            stats: { ...lastStats, opsPerSec: avgOps, blockTimeMs: avgBlockTime.toFixed(0) }
        });
    }

    // Combined table
    printTable('Block Throughput — With Cache', cachedRows);
    printTable('Block Throughput — Without Cache', uncachedRows);

    // Cache impact summary
    console.log('\n  Cache Impact (uncached / cached block time):');
    for (let i = 0; i < BLOCK_SIZES.length; i++) {
        const cached   = parseFloat(cachedRows[i].stats.blockTimeMs);
        const uncached = parseFloat(uncachedRows[i].stats.blockTimeMs);
        const ratio    = uncached / cached;
        console.log('    Block/' + String(BLOCK_SIZES[i]).padEnd(5) + ': ' +
            ratio.toFixed(2) + 'x speedup from cache');
    }

    const memAfter = memSnapshot();
    printMemory(memBefore, memAfter);

    console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
