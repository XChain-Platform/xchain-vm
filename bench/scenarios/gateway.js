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
 * Gateway Method Benchmarks
 *
 * Isolates each gateway method category to measure per-call overhead:
 *   - Context getters (0 gas)
 *   - State reads / writes
 *   - Emit operations
 *   - Math operations
 *   - Mixed workload
 *
 * Each contract calls one category many times; total execution time
 * divided by call count gives per-call latency.
 ********************************************************************/

const {
    createVM, createContext,
    measure, collectStats, printTable
} = require('../harness.js');

const ITERATIONS = 50;
const WARMUP     = 5;

const CONTRACTS = {
    context_getters: `
module.exports = function(xchain) {
    var result = [];
    for (var i = 0; i < 100; i++) {
        xchain.getBlockHeight();
        xchain.getBlockTimestamp();
        xchain.getBlockHash();
        xchain.getSourceAddress();
        xchain.getContractAddress();
    }
    return 500; // 5 calls x 100 iterations
};`,

    state_reads: `
module.exports = function(xchain) {
    for (var i = 0; i < 100; i++) {
        xchain.state.get('key_' + (i % 10));
    }
    return 100;
};`,

    state_writes: `
module.exports = function(xchain) {
    for (var i = 0; i < 100; i++) {
        xchain.state.set('key_' + i, 'value_' + i);
    }
    return 100;
};`,

    state_mixed: `
module.exports = function(xchain) {
    for (var i = 0; i < 50; i++) {
        xchain.state.set('key_' + i, 'val_' + i);
    }
    for (var i = 0; i < 50; i++) {
        xchain.state.get('key_' + i);
    }
    for (var i = 0; i < 10; i++) {
        xchain.state.has('key_' + i);
    }
    for (var i = 0; i < 10; i++) {
        xchain.state.delete('key_' + i);
    }
    return 120;
};`,

    emit_send: `
module.exports = function(xchain) {
    for (var i = 0; i < 20; i++) {
        xchain.emit.send({ destination: 'addr_' + i, tick: 'TOKEN', quantity: '100' });
    }
    return 20;
};`,

    math_ops: `
module.exports = function(xchain) {
    var a = '1000000000';
    var b = '999999999';
    for (var i = 0; i < 100; i++) {
        xchain.math.add(a, b);
        xchain.math.subtract(a, b);
        xchain.math.multiply(a, '2');
        xchain.math.divide(a, '3');
        xchain.math.compare(a, b);
    }
    return 500; // 5 ops x 100 iterations
};`,

    math_comparison: `
module.exports = function(xchain) {
    var a = '1000000000';
    var b = '999999999';
    for (var i = 0; i < 100; i++) {
        xchain.math.gt(a, b);
        xchain.math.gte(a, b);
        xchain.math.lt(a, b);
        xchain.math.lte(a, b);
        xchain.math.eq(a, b);
        xchain.math.isZero(a);
    }
    return 600;
};`,

    logging: `
module.exports = function(xchain) {
    for (var i = 0; i < 50; i++) {
        xchain.log('message ' + i);
    }
    return 50;
};`
};

async function main() {
    console.log('XChain VM Gateway Method Benchmarks');
    console.log('Node ' + process.version + ' | Iterations: ' + ITERATIONS);

    const vm   = createVM({ gasCeiling: 50000000 });
    const rows = [];

    for (const [name, code] of Object.entries(CONTRACTS)) {
        const ctx = createContext();
        let callsPerExec = 0;

        const timings = await measure(async () => {
            const result = await vm.execute({ code, ...ctx });
            if (!result.success) throw new Error(name + ' failed: ' + result.error);
            callsPerExec = JSON.parse(result.returnValue);
        }, ITERATIONS, WARMUP);

        const stats = collectStats(timings);

        const perCallUs = (stats.mean / callsPerExec) * 1000;
        rows.push({
            label: name + ' (' + callsPerExec + ' calls)',
            stats
        });

        console.log('  ' + name.padEnd(20) + ': ' +
            stats.mean.toFixed(2) + 'ms total, ' +
            perCallUs.toFixed(1) + 'us/call (' + callsPerExec + ' calls)');
    }

    printTable('Gateway Method Latency (full execute)', rows);

    console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
