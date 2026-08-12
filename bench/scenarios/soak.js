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
 * Soak Test
 *
 * Continuous block processing at moderate load for a configurable
 * duration. Monitors memory stability and throughput consistency.
 *
 * Usage:
 *   node bench/scenarios/soak.js [duration_seconds]
 *   Default: 60 seconds
 ********************************************************************/

const { performance } = require('perf_hooks');
const {
    createVM, createContext, loadContract,
    collectStats, memSnapshot, fmt
} = require('../harness.js');

const DURATION_S     = parseInt(process.argv[2] || '60', 10);
const BLOCK_SIZE     = 100;
const SAMPLE_INTERVAL_S = 10;

const TIER_MIX = [
    { tier: 'light',  weight: 0.70, code: null },
    { tier: 'medium', weight: 0.20, code: null },
    { tier: 'heavy',  weight: 0.10, code: null }
];

function pickTier() {
    const r = Math.random();
    let cumulative = 0;
    for (const t of TIER_MIX) {
        cumulative += t.weight;
        if (r <= cumulative) return t;
    }
    return TIER_MIX[0];
}

async function processBlock(vm, blockNum) {
    const timings = [];
    let errors = 0;

    vm.beginBlock();
    for (let i = 0; i < BLOCK_SIZE; i++) {
        const tier = pickTier();
        const ctx = createContext({
            contractIndex: i + 1,
            blockContext: { height: 100000 + blockNum, timestamp: 1700000000 + blockNum, hash: 'block' + blockNum }
        });

        const start = performance.now();
        const result = await vm.execute({ code: tier.code, ...ctx });
        timings.push(performance.now() - start);

        if (!result.success) errors++;
    }
    vm.endBlock();

    return { timings, errors };
}

async function main() {
    console.log('XChain VM Soak Test');
    console.log('Node ' + process.version + ' | Duration: ' + DURATION_S + 's | Block size: ' + BLOCK_SIZE);
    console.log('Mix: 70% light / 20% medium / 10% heavy');

    TIER_MIX[0].code = loadContract('light.js');
    TIER_MIX[1].code = loadContract('medium.js');
    TIER_MIX[2].code = loadContract('heavy.js');

    const vm = createVM();
    const samples = [];
    let totalContracts = 0;
    let totalErrors    = 0;
    let totalBlocks    = 0;
    let allTimings     = [];

    const startTime   = performance.now();
    const durationMs  = DURATION_S * 1000;
    let lastSampleTime = startTime;
    let sampleContracts = 0;
    let sampleTimings   = [];

    console.log('\n  Time      | Blocks | Contracts | Ops/s    | P99       | RSS (MB) | Heap (MB) | Errors');
    console.log('  ' + '-'.repeat(95));

    while (performance.now() - startTime < durationMs) {
        const result = await processBlock(vm, totalBlocks);
        totalBlocks++;
        totalContracts += BLOCK_SIZE;
        totalErrors    += result.errors;
        sampleContracts += BLOCK_SIZE;
        sampleTimings   = sampleTimings.concat(result.timings);
        allTimings      = allTimings.concat(result.timings);

        const now = performance.now();
        if (now - lastSampleTime >= SAMPLE_INTERVAL_S * 1000) {
            const elapsed   = (now - startTime) / 1000;
            const sampleOps = sampleContracts / ((now - lastSampleTime) / 1000);
            const stats     = collectStats(sampleTimings);
            const mem       = memSnapshot();

            samples.push({
                elapsedS:  elapsed.toFixed(0),
                blocks:    totalBlocks,
                contracts: totalContracts,
                opsPerSec: sampleOps.toFixed(1),
                p99:       stats.p99,
                rssMb:     mem.rssMb,
                heapMb:    mem.heapUsedMb,
                errors:    totalErrors
            });

            console.log('  ' + [
                (elapsed.toFixed(0) + 's').padStart(8),
                String(totalBlocks).padStart(7),
                String(totalContracts).padStart(10),
                (sampleOps.toFixed(1) + '/s').padStart(9),
                fmt(stats.p99).padStart(10),
                String(mem.rssMb).padStart(9),
                String(mem.heapUsedMb).padStart(10),
                String(totalErrors).padStart(7)
            ].join(' | '));

            lastSampleTime  = now;
            sampleContracts = 0;
            sampleTimings   = [];
        }
    }

    const totalTime = (performance.now() - startTime) / 1000;

    console.log('\n' + '='.repeat(80));
    console.log('  Soak Test Summary');
    console.log('='.repeat(80));
    console.log('  Duration:          ' + totalTime.toFixed(1) + 's');
    console.log('  Blocks processed:  ' + totalBlocks);
    console.log('  Total contracts:   ' + totalContracts);
    console.log('  Total errors:      ' + totalErrors);
    console.log('  Avg throughput:    ' + (totalContracts / totalTime).toFixed(1) + ' contracts/s');

    const overallStats = collectStats(allTimings);
    console.log('  Latency P50:       ' + fmt(overallStats.p50));
    console.log('  Latency P95:       ' + fmt(overallStats.p95));
    console.log('  Latency P99:       ' + fmt(overallStats.p99));
    console.log('  Latency Mean:      ' + fmt(overallStats.mean));

    if (samples.length >= 2) {
        const firstMem = samples[0].rssMb;
        const lastMem  = samples[samples.length - 1].rssMb;
        const growth   = lastMem - firstMem;
        const growthPct = ((growth / firstMem) * 100).toFixed(1);
        console.log('  Memory growth:     ' + growth.toFixed(2) + ' MB (' + growthPct + '%)');

        const firstOps = parseFloat(samples[0].opsPerSec);
        const lastOps  = parseFloat(samples[samples.length - 1].opsPerSec);
        const throughputDrift = (((lastOps - firstOps) / firstOps) * 100).toFixed(1);
        console.log('  Throughput drift:  ' + throughputDrift + '%');

        const memPass  = Math.abs(parseFloat(growthPct)) < 10;
        const driftPass = Math.abs(parseFloat(throughputDrift)) < 20;
        console.log('\n  Memory stability:   ' + (memPass ? 'PASS' : 'FAIL') + ' (threshold: <10% growth)');
        console.log('  Throughput stability: ' + (driftPass ? 'PASS' : 'FAIL') + ' (threshold: <20% drift)');
    }

    console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
