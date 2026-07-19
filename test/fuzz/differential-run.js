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
 * VM Differential-Fuzz CLI (cross-arch / cross-build driver).
 *
 * Usage:
 *   node test/fuzz/differential-run.js record  [--seed N] [--cases M] \
 *        [--execution in-process|subprocess] --out FILE
 *   node test/fuzz/differential-run.js verify  [--seed N] [--cases M] --against FILE
 *   node test/fuzz/differential-run.js compare A.json B.json
 *
 * `record` writes this platform's manifest. Run it in each matrix leg
 * (different arch / Node ABI / libc) and upload the manifests as artifacts.
 * `compare` (or `verify`) then asserts every case's consensus hash matches
 * across every pair; a non-empty divergence set exits non-zero and IS the
 * differential failure. See .github/workflows/vm-differential-fuzz.yml.
 ********************************************************************/

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_SEED,
    DEFAULT_CASES,
    buildManifest,
    diffManifests,
    platformTag
} = require('./differential');

function parseFlags(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i++;
            }
        } else {
            positional.push(a);
        }
    }
    return { flags, positional };
}

function reportDivergences(divs) {
    process.stderr.write(`\nDIFFERENTIAL DIVERGENCE: ${divs.length} case(s) disagree.\n`);
    for (const d of divs.slice(0, 25)) {
        process.stderr.write('  - ' + d.detail + '\n');
    }
    if (divs.length > 25) {
        process.stderr.write(`  ... and ${divs.length - 25} more\n`);
    }
}

async function cmdRecord(flags) {
    const seed = flags.seed != null && flags.seed !== true ? parseInt(flags.seed, 10) : DEFAULT_SEED;
    const cases = flags.cases != null && flags.cases !== true ? parseInt(flags.cases, 10) : DEFAULT_CASES;
    const execution = flags.execution && flags.execution !== true ? flags.execution : 'in-process';

    process.stdout.write(`[differential] recording on ${platformTag()} ` +
        `(seed=${seed}, cases=${cases}, execution=${execution})\n`);

    const manifest = await buildManifest({ seed, cases, execution });

    const out = flags.out && flags.out !== true
        ? flags.out
        : path.join(__dirname, `differential.${manifest.platform}.json`);
    fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write(`[differential] wrote ${out} (${manifest.entries.length} cases)\n`);
    return 0;
}

async function cmdVerify(flags) {
    const againstPath = flags.against;
    if (!againstPath || againstPath === true) {
        process.stderr.write('verify requires --against FILE\n');
        return 2;
    }
    const ref = JSON.parse(fs.readFileSync(againstPath, 'utf8'));
    const seed = flags.seed != null && flags.seed !== true ? parseInt(flags.seed, 10) : ref.seed;
    const cases = flags.cases != null && flags.cases !== true ? parseInt(flags.cases, 10) : ref.cases;

    process.stdout.write(`[differential] verifying ${platformTag()} against ` +
        `${ref.platform} (seed=${seed}, cases=${cases})\n`);

    const live = await buildManifest({ seed, cases, execution: ref.execution || 'in-process' });
    const divs = diffManifests(ref, live);
    if (divs.length) { reportDivergences(divs); return 1; }
    process.stdout.write(`[differential] OK: ${live.entries.length} cases match ${ref.platform}\n`);
    return 0;
}

function cmdCompare(positional) {
    if (positional.length < 2) {
        process.stderr.write('compare requires two manifest files: compare A.json B.json\n');
        return 2;
    }
    const a = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    const b = JSON.parse(fs.readFileSync(positional[1], 'utf8'));
    process.stdout.write(`[differential] comparing ${a.platform} vs ${b.platform}\n`);
    const divs = diffManifests(a, b);
    if (divs.length) { reportDivergences(divs); return 1; }
    process.stdout.write(`[differential] OK: ${a.entries.length} cases identical across builds\n`);
    return 0;
}

async function main() {
    const { flags, positional } = parseFlags(process.argv.slice(2));
    const cmd = positional.shift();

    let code;
    switch (cmd) {
        case 'record':  code = await cmdRecord(flags); break;
        case 'verify':  code = await cmdVerify(flags); break;
        case 'compare': code = cmdCompare(positional); break;
        default:
            process.stderr.write(
                'usage: differential-run.js <record|verify|compare> [options]\n' +
                '  record  [--seed N] [--cases M] [--execution MODE] [--out FILE]\n' +
                '  verify  [--seed N] [--cases M] --against FILE\n' +
                '  compare A.json B.json\n');
            code = 2;
    }
    process.exit(code);
}

main().catch(e => {
    if (e && e.code === 'NO_ISOLATED_VM') {
        process.stderr.write('isolated-vm not available; run under the validator ABI (Node 22, ' +
            'Linux) with `npm rebuild isolated-vm --build-from-source`.\n');
        process.exit(3);
    }
    process.stderr.write('differential-run failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
