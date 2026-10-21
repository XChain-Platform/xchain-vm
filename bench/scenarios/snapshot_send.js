#!/usr/bin/env node
// @ts-nocheck
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
 * Snapshot Send Time Benchmark
 *
 * Measures the wall time of delivering a cross-chain snapshot through a
 * live ProcessExecutor worker, in two shapes:
 *   - inline:    executions outside any block, so the full snapshot rides
 *                on every execute frame
 *   - per block: executions inside beginBlock/endBlock, so the snapshot is
 *                sent once per block and execute frames carry a reference
 *
 * Frames are counted from child.send, so the numbers show how often the
 * snapshot crossed the process boundary as well as how long it took.
 ********************************************************************/

const { performance } = require('perf_hooks');
const { GAS_SCHEDULE, createContext } = require('../harness.js');
const ProcessExecutor = require('../../src/process-executor.js');

// The worker validates the full schedule, and the harness one predates the
// cross-call entries, so they are added here without touching the harness.
const SCHEDULE = Object.assign({}, GAS_SCHEDULE, { VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000 });
const GAS_CEILING = 10000000;
const LIMITS = {
    maxCpuTimeMs:      30000,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxCodeSize:       65536,
    maxBlockCacheSize: 1000
};
const CODE = 'module.exports = function(){ return xchain.crossChain.isSettled("BTC", 0); };';

function makeSnapshot(entries) {
    const settled = {};
    const calls = {};
    for (let n = 0; n < entries; n++) {
        settled['BTC:' + n] = true;
        calls[n.toString(16).padStart(8, '0')] = { status: 'ok', payload: 'p' + n };
    }
    return { attestations: {}, settled, calls };
}

async function waitReady(exec) {
    const end = Date.now() + 15000;
    while (!exec._sawReady && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!exec._sawReady) throw new Error('worker never became ready');
}

function captureFrames(exec) {
    const frames = [];
    const child = exec._child;
    const realSend = child.send.bind(child);
    child.send = function (msg, ...rest) {
        frames.push({
            type: msg && msg.type,
            carriesSnapshot: !!(msg && msg.type === 'execute' && msg.opts &&
                msg.opts.crossChainData && !msg.opts.crossChainData.__xchainWorkerSnapshot)
        });
        return realSend(msg, ...rest);
    };
    return frames;
}

async function executeOnce(exec, snapshot) {
    const ctx = createContext({ crossChainData: JSON.parse(JSON.stringify(snapshot)) });
    const result = await exec.execute({ code: CODE, ...ctx });
    if (!result.success) throw new Error('Execution failed: ' + result.error);
}

function countFrames(frames) {
    return {
        snapshotFrames: frames.filter((f) => f.type === 'snapshot').length,
        executeFramesWithSnapshot: frames.filter((f) => f.carriesSnapshot).length
    };
}

async function runSize(entries, executions, blocks) {
    const snapshot = makeSnapshot(entries);
    const exec = new ProcessExecutor({
        gasSchedule: SCHEDULE,
        gasCeiling: GAS_CEILING,
        limits: LIMITS
    });
    try {
        await waitReady(exec);
        const frames = captureFrames(exec);

        const inlineStart = performance.now();
        for (let i = 0; i < executions; i++) await executeOnce(exec, snapshot);
        const inlineMs = performance.now() - inlineStart;
        const inlineFrames = countFrames(frames);

        frames.length = 0;
        const blockStart = performance.now();
        for (let b = 0; b < blocks; b++) {
            exec.beginBlock();
            for (let i = 0; i < executions; i++) await executeOnce(exec, snapshot);
            exec.endBlock();
        }
        const blockMs = performance.now() - blockStart;
        const blockFrames = countFrames(frames);

        return {
            entries,
            bytes: Buffer.byteLength(JSON.stringify(snapshot)),
            executions,
            blocks,
            inline: { ms: inlineMs, perExecMs: inlineMs / executions, ...inlineFrames },
            perBlock: { ms: blockMs, perBlockMs: blockMs / blocks, ...blockFrames }
        };
    } finally {
        await exec.shutdown();
    }
}

async function run({ sizes = [10, 1000, 10000], executions = 20, blocks = 3 } = {}) {
    const results = [];
    for (const entries of sizes) results.push(await runSize(entries, executions, blocks));
    return { results };
}

function parseArgs(argv) {
    const opts = { sizes: [10, 1000, 10000], executions: 20, blocks: 3, json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') opts.json = true;
        else if (arg === '--sizes') opts.sizes = String(argv[++i]).split(',').map(Number);
        else if (arg === '--executions') opts.executions = Number(argv[++i]);
        else if (arg === '--blocks') opts.blocks = Number(argv[++i]);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const out = await run(opts);
    if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    for (const r of out.results) {
        console.log(String(r.entries).padStart(6) + ' entries ' +
            String(r.bytes).padStart(9) + ' B | inline ' + r.inline.ms.toFixed(1) + 'ms (' +
            r.inline.perExecMs.toFixed(2) + 'ms/exec, ' + r.inline.executeFramesWithSnapshot +
            ' full frames) | per block ' + r.perBlock.ms.toFixed(1) + 'ms (' +
            r.perBlock.perBlockMs.toFixed(2) + 'ms/block, ' + r.perBlock.snapshotFrames +
            ' snapshot frames)');
    }
}

module.exports = { makeSnapshot, run };

if (require.main === module) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
