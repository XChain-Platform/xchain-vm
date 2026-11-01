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
 * Both modes run the same total execution count on fresh workers. An odd
 * number of paired samples alternates which mode runs first. Reported timings
 * come from the pair with the median ratio, so scheduler noise does not decide
 * the comparison and the two displayed times remain directly comparable.
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
const ACCEPTANCE_SIZES = [1, 10000];
const ACCEPTANCE_MAX_RATIO = 1;

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

async function withExecutor(runMode) {
    const exec = new ProcessExecutor({
        gasSchedule: SCHEDULE,
        gasCeiling: GAS_CEILING,
        limits: LIMITS
    });
    try {
        await waitReady(exec);
        return await runMode(exec, captureFrames(exec));
    } finally {
        await exec.shutdown();
    }
}

function countFrames(frames) {
    return {
        snapshotFrames: frames.filter((f) => f.type === 'snapshot').length,
        executeFramesWithSnapshot: frames.filter((f) => f.carriesSnapshot).length
    };
}

async function measureInline(snapshot, executions) {
    return withExecutor(async (exec, frames) => {
        const start = performance.now();
        for (let i = 0; i < executions; i++) await executeOnce(exec, snapshot);
        const ms = performance.now() - start;
        return { ms, perExecMs: ms / executions, ...countFrames(frames) };
    });
}

async function measurePerBlock(snapshot, executions, blocks) {
    return withExecutor(async (exec, frames) => {
        const start = performance.now();
        for (let b = 0; b < blocks; b++) {
            exec.beginBlock();
            const blockExecutions = Math.floor(executions / blocks) +
                (b < executions % blocks ? 1 : 0);
            for (let i = 0; i < blockExecutions; i++) await executeOnce(exec, snapshot);
            exec.endBlock();
        }
        const ms = performance.now() - start;
        return {
            ms,
            perExecMs: ms / executions,
            perBlockMs: ms / blocks,
            ...countFrames(frames)
        };
    });
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

async function runSize(entries, executions, blocks, samples) {
    const snapshot = makeSnapshot(entries);
    const pairs = [];
    for (let sample = 0; sample < samples; sample++) {
        let inline;
        let perBlock;
        if (sample % 2 === 0) {
            inline = await measureInline(snapshot, executions);
            perBlock = await measurePerBlock(snapshot, executions, blocks);
        } else {
            perBlock = await measurePerBlock(snapshot, executions, blocks);
            inline = await measureInline(snapshot, executions);
        }
        pairs.push({ inline, perBlock, ratio: perBlock.ms / inline.ms });
    }
    const selected = pairs.slice().sort((a, b) => a.ratio - b.ratio)[Math.floor(samples / 2)];

    return {
        entries,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
        executions,
        blocks,
        samples,
        inline: Object.assign({}, selected.inline, {
            medianMs: median(pairs.map((pair) => pair.inline.ms)),
            sampleMs: pairs.map((pair) => pair.inline.ms)
        }),
        perBlock: Object.assign({}, selected.perBlock, {
            medianMs: median(pairs.map((pair) => pair.perBlock.ms)),
            sampleMs: pairs.map((pair) => pair.perBlock.ms)
        }),
        comparison: {
            medianRatio: selected.ratio,
            sampleRatios: pairs.map((pair) => pair.ratio)
        }
    };
}

function evaluateAcceptance(results) {
    const bySize = new Map(results.map((result) => [result.entries, result]));
    const missingSizes = ACCEPTANCE_SIZES.filter((entries) => !bySize.has(entries));
    const regressions = ACCEPTANCE_SIZES
        .filter((entries) => bySize.has(entries))
        .map((entries) => ({
            entries,
            ratio: bySize.get(entries).comparison.medianRatio
        }))
        .filter(({ ratio }) => !Number.isFinite(ratio) || ratio > ACCEPTANCE_MAX_RATIO);
    return {
        passed: missingSizes.length === 0 && regressions.length === 0,
        maxRatio: ACCEPTANCE_MAX_RATIO,
        requiredSizes: ACCEPTANCE_SIZES.slice(),
        missingSizes,
        regressions
    };
}

function assertAcceptance(acceptance) {
    if (acceptance.passed) return;
    const failures = [];
    if (acceptance.missingSizes.length)
        failures.push('missing required sizes: ' + acceptance.missingSizes.join(', '));
    if (acceptance.regressions.length) {
        failures.push('per-block slower at ' + acceptance.regressions.map(({ entries, ratio }) =>
            entries + ' entries (' + ratio.toFixed(3) + 'x inline)').join(', '));
    }
    throw new Error('Snapshot send benchmark acceptance failed: ' + failures.join('; '));
}

async function run({ sizes = [1, 1000, 10000], executions = 60, blocks = 3, samples = 3 } = {}) {
    if (!Number.isInteger(executions) || executions < 1)
        throw new Error('executions must be a positive integer');
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > executions)
        throw new Error('blocks must be a positive integer no greater than executions');
    if (!Number.isInteger(samples) || samples < 1 || samples % 2 === 0)
        throw new Error('samples must be a positive odd integer');
    const results = [];
    for (const entries of sizes) results.push(await runSize(entries, executions, blocks, samples));
    return { results, acceptance: evaluateAcceptance(results) };
}

function parseArgs(argv) {
    const opts = {
        sizes: [1, 1000, 10000], executions: 60, blocks: 3, samples: 3,
        json: false, check: true
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') opts.json = true;
        else if (arg === '--sizes') opts.sizes = String(argv[++i]).split(',').map(Number);
        else if (arg === '--executions') opts.executions = Number(argv[++i]);
        else if (arg === '--blocks') opts.blocks = Number(argv[++i]);
        else if (arg === '--samples') opts.samples = Number(argv[++i]);
        else if (arg === '--no-check') opts.check = false;
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const out = await run(opts);
    if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
    } else {
        for (const r of out.results) {
            const ratio = r.comparison.medianRatio;
            console.log(String(r.entries).padStart(6) + ' entries ' +
                String(r.bytes).padStart(9) + ' B | inline ' + r.inline.ms.toFixed(1) + 'ms (' +
                r.inline.perExecMs.toFixed(2) + 'ms/exec, ' + r.inline.executeFramesWithSnapshot +
                ' full frames) | per block ' + r.perBlock.ms.toFixed(1) + 'ms (' +
                r.perBlock.perExecMs.toFixed(2) + 'ms/exec, ' + r.perBlock.snapshotFrames +
                ' snapshot frames, ' + ratio.toFixed(2) + 'x inline median over ' +
                r.samples + ' samples)');
        }
        if (opts.check && out.acceptance.passed) {
            console.log('Acceptance PASS: per-block is no slower than inline at ' +
                out.acceptance.requiredSizes.join(' and ') + ' entries.');
        }
    }
    if (opts.check) assertAcceptance(out.acceptance);
}

module.exports = { assertAcceptance, evaluateAcceptance, makeSnapshot, run };

if (require.main === module) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
