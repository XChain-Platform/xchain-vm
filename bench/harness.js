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
 * XChain VM: Benchmark Harness
 *
 * Core utilities for performance testing the VM runtime.
 * Provides timing, statistics, memory tracking, and formatted output.
 ********************************************************************/
// @ts-nocheck

const { performance } = require('perf_hooks');
const v8   = require('v8');
const path = require('path');
const fs   = require('fs');

const XChainVM = require('../src/index.js');

// Matches the gas schedule used across the test suite, so benchmark numbers
// are comparable to test-observed costs.
const GAS_SCHEDULE = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_EMISSION:        500
};

/**
 * Create a VM instance with benchmark-appropriate defaults.
 * @param {object} [overrides] - Override any config field
 * @returns {XChainVM}
 */
function createVM(overrides = {}) {
    return new XChainVM({
        gasSchedule: overrides.gasSchedule || GAS_SCHEDULE,
        gasCeiling:  overrides.gasCeiling  || 10000000,
        limits: {
            maxCpuTimeMs:      overrides.maxCpuTimeMs      || 30000,
            maxMemory:         overrides.maxMemory          || 8,
            maxEmissions:      overrides.maxEmissions       || 50,
            maxStateKeys:      overrides.maxStateKeys       || 10000,
            maxStateValueSize: overrides.maxStateValueSize  || 65536,
            maxCodeSize:       overrides.maxCodeSize        || 65536,
            maxBlockCacheSize: overrides.maxBlockCacheSize  || 1000
        }
    });
}

/**
 * Build a default execution context. Override any field.
 * @param {object} [overrides]
 * @returns {object}
 */
function createContext(overrides = {}) {
    return {
        method:          overrides.method          || 'default',
        params:          overrides.params          || [],
        caller:          overrides.caller          || 'bench_caller_address',
        contractAddress: overrides.contractAddress || 'C:BTC:1',
        blockContext:    overrides.blockContext     || { height: 100000, timestamp: 1700000000, hash: 'benchhash000' },
        state:           overrides.state           || {},
        balances:        overrides.balances         || {},
        tokenInfo:       overrides.tokenInfo        || {},
        oracleData:      overrides.oracleData       || null,
        crossChainData:  overrides.crossChainData   || null,
        contractIndex:   overrides.contractIndex    || 1
    };
}

/**
 * Load a benchmark contract from bench/contracts/.
 * @param {string} name - Filename relative to bench/contracts/
 * @returns {string}
 */
function loadContract(name) {
    return fs.readFileSync(path.join(__dirname, 'contracts', name), 'utf8');
}

/**
 * Run an async function N times and collect per-iteration timings.
 * @param {function} fn - Async function to benchmark
 * @param {number} iterations - Number of measured iterations
 * @param {number} [warmup=5] - Warmup iterations (not measured)
 * @returns {Promise<number[]>} Array of timings in ms
 */
async function measure(fn, iterations, warmup = 5) {
    for (let i = 0; i < warmup; i++) {
        await fn(i);
    }

    const timings = new Array(iterations);
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn(i);
        timings[i] = performance.now() - start;
    }
    return timings;
}

/**
 * Compute statistics from an array of timing values.
 * @param {number[]} timings
 * @returns {object}
 */
function collectStats(timings) {
    if (timings.length === 0) return { count: 0 };

    const sorted = [...timings].sort((a, b) => a - b);
    const count  = sorted.length;
    const sum    = sorted.reduce((a, b) => a + b, 0);
    const mean   = sum / count;

    const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count;
    const stddev   = Math.sqrt(variance);

    return {
        count,
        min:    sorted[0],
        max:    sorted[count - 1],
        mean,
        stddev,
        p50:    percentile(sorted, 0.50),
        p95:    percentile(sorted, 0.95),
        p99:    percentile(sorted, 0.99),
        sum
    };
}

function percentile(sorted, pct) {
    const idx = Math.ceil(pct * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

/**
 * Capture a memory snapshot.
 * @returns {object}
 */
function memSnapshot() {
    const mem  = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    return {
        rssMb:       +(mem.rss / 1024 / 1024).toFixed(2),
        heapUsedMb:  +(mem.heapUsed / 1024 / 1024).toFixed(2),
        heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
        externalMb:  +(mem.external / 1024 / 1024).toFixed(2),
        v8HeapUsedMb: +(heap.used_heap_size / 1024 / 1024).toFixed(2),
        v8HeapTotalMb: +(heap.total_heap_size / 1024 / 1024).toFixed(2)
    };
}

/**
 * Format a stats object into a single display row.
 * @param {string} label
 * @param {object} stats
 * @returns {string}
 */
function formatStatsRow(label, stats) {
    return [
        label.padEnd(28),
        fmt(stats.mean).padStart(10),
        fmt(stats.p50).padStart(10),
        fmt(stats.p95).padStart(10),
        fmt(stats.p99).padStart(10),
        fmt(stats.min).padStart(10),
        fmt(stats.max).padStart(10),
        fmt(stats.stddev).padStart(10),
        String(stats.count).padStart(6)
    ].join('');
}

function fmt(v) {
    if (v === undefined || v === null) return '-';
    if (v >= 1000) return v.toFixed(0) + 'ms';
    if (v >= 1)    return v.toFixed(2) + 'ms';
    return (v * 1000).toFixed(0) + 'us';
}

/**
 * Print a stats table header.
 */
function printHeader(title) {
    console.log('\n' + '='.repeat(114));
    console.log('  ' + title);
    console.log('='.repeat(114));
    console.log([
        'Benchmark'.padEnd(28),
        'Mean'.padStart(10),
        'P50'.padStart(10),
        'P95'.padStart(10),
        'P99'.padStart(10),
        'Min'.padStart(10),
        'Max'.padStart(10),
        'StdDev'.padStart(10),
        'N'.padStart(6)
    ].join(''));
    console.log('-'.repeat(114));
}

/**
 * Print a table of benchmark results.
 * @param {string} title
 * @param {Array<{label: string, stats: object}>} rows
 */
function printTable(title, rows) {
    printHeader(title);
    for (const row of rows) {
        console.log(formatStatsRow(row.label, row.stats));
    }
    console.log('-'.repeat(114));
}

/**
 * Print a memory comparison.
 * @param {object} before
 * @param {object} after
 */
function printMemory(before, after) {
    console.log('\n  Memory (before -> after):');
    console.log('    RSS:        ' + before.rssMb + ' -> ' + after.rssMb + ' MB (delta: ' + (after.rssMb - before.rssMb).toFixed(2) + ')');
    console.log('    Heap Used:  ' + before.heapUsedMb + ' -> ' + after.heapUsedMb + ' MB (delta: ' + (after.heapUsedMb - before.heapUsedMb).toFixed(2) + ')');
    console.log('    External:   ' + before.externalMb + ' -> ' + after.externalMb + ' MB (delta: ' + (after.externalMb - before.externalMb).toFixed(2) + ')');
}

/**
 * Generate a JSON report for CI consumption.
 * @param {string} scenario
 * @param {object} results
 * @returns {object}
 */
function buildReport(scenario, results) {
    return {
        timestamp: new Date().toISOString(),
        node:      process.version,
        platform:  process.platform + '-' + process.arch,
        scenario,
        results
    };
}

module.exports = {
    GAS_SCHEDULE,
    createVM,
    createContext,
    loadContract,
    measure,
    collectStats,
    memSnapshot,
    printHeader,
    printTable,
    printMemory,
    formatStatsRow,
    buildReport,
    fmt
};
