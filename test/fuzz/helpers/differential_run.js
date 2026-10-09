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
 *   node test/fuzz/helpers/differential_run.js record  [--seed N] [--cases M] \
 *        [--execution in-process|subprocess] [--profile legacy|post-gate] \
 *        [--require-pinned-runtime] --out FILE
 *   node test/fuzz/helpers/differential_run.js verify  [--seed N] [--cases M] \
 *        [--profile legacy|post-gate] --against FILE
 *   node test/fuzz/helpers/differential_run.js compare A.json B.json
 *   node test/fuzz/helpers/differential_run.js check-legs DIR [--seed N] [--cases M] \
 *        [--profile legacy|post-gate]
 *
 * `record` writes this platform's manifest. Run it in each matrix leg
 * (different arch / Node ABI / libc) and upload the manifests as artifacts.
 * `compare` (or `verify`) then asserts every case's consensus hash matches
 * across every pair; a non-empty divergence set exits non-zero and IS the
 * differential failure. `check-legs` asserts every expected matrix leg left a
 * manifest of the platform it claims, on the pinned consensus engine, so a
 * dropped or mislabelled leg cannot shrink the comparison silently. See
 * .github/workflows/vm-differential-fuzz.yml.
 ********************************************************************/

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_SEED,
    DEFAULT_CASES,
    buildManifest,
    diffManifests,
    platformTag
} = require('./differential.js');
const { buildPostGateManifest } = require('./differential_postgate.js');
const { checkLegSet } = require('./differential_legs.js');
const { checkConsensusRuntime, describeMismatch } = require('../../../src/consensus-runtime.js');

const PROFILES = ['legacy', 'post-gate'];

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

function flagProfile(flags) {
    const profile = flags.profile && flags.profile !== true ? flags.profile : 'legacy';
    if (!PROFILES.includes(profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
    return profile;
}

function buildFor(profile, opts) {
    return profile === 'post-gate' ? buildPostGateManifest(opts) : buildManifest(opts);
}

async function cmdRecord(flags) {
    const seed = flags.seed != null && flags.seed !== true ? parseInt(flags.seed, 10) : DEFAULT_SEED;
    const cases = flags.cases != null && flags.cases !== true ? parseInt(flags.cases, 10) : DEFAULT_CASES;
    const execution = flags.execution && flags.execution !== true ? flags.execution : 'in-process';
    const profile = flagProfile(flags);

    // Fail closed before the corpus runs: a leg on an off-pin engine compares an
    // engine no validator may run.
    const runtime = checkConsensusRuntime();
    if (flags['require-pinned-runtime'] && !runtime.ok) {
        process.stderr.write(describeMismatch(runtime) + '\n');
        return 4;
    }

    process.stdout.write(`[differential] recording on ${platformTag()} ` +
        `(seed=${seed}, cases=${cases}, execution=${execution}, profile=${profile})\n`);

    const manifest = await buildFor(profile, { seed, cases, execution });
    manifest.consensusRuntime = { ok: runtime.ok, mismatches: runtime.mismatches };
    if (Array.isArray(manifest.regime) && manifest.regime.length) {
        process.stderr.write('post-gate profile is not in the post-gate regime:\n  - ' +
            manifest.regime.join('\n  - ') + '\n');
        return 5;
    }

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

    const profile = flags.profile ? flagProfile(flags) : (ref.profile || 'legacy');

    process.stdout.write(`[differential] verifying ${platformTag()} against ` +
        `${ref.platform} (seed=${seed}, cases=${cases}, profile=${profile})\n`);

    const live = await buildFor(profile, { seed, cases, execution: ref.execution || 'in-process' });
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

function cmdCheckLegs(flags, positional) {
    const dir = positional[0];
    if (!dir) {
        process.stderr.write('check-legs requires a manifest directory: check-legs DIR\n');
        return 2;
    }
    const want = { profile: flagProfile(flags) };
    if (flags.seed != null && flags.seed !== true) want.seed = parseInt(flags.seed, 10);
    if (flags.cases != null && flags.cases !== true) want.cases = parseInt(flags.cases, 10);
    const problems = checkLegSet(dir, want);
    if (problems.length) {
        process.stderr.write(`DIFFERENTIAL LEG CHECK FAILED (${want.profile}): ${problems.length} problem(s)\n`);
        for (const p of problems) process.stderr.write('  - ' + p + '\n');
        return 1;
    }
    process.stdout.write(`[differential] every expected ${want.profile} leg is present, distinct and on the pinned engine\n`);
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
        case 'check-legs': code = cmdCheckLegs(flags, positional); break;
        default:
            process.stderr.write(
                'usage: differential_run.js <record|verify|compare|check-legs> [options]\n' +
                '  record  [--seed N] [--cases M] [--execution MODE] [--profile P] [--require-pinned-runtime] [--out FILE]\n' +
                '  verify  [--seed N] [--cases M] [--profile P] --against FILE\n' +
                '  compare A.json B.json\n' +
                '  check-legs DIR [--seed N] [--cases M] [--profile P]\n');
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
    process.stderr.write('differential_run failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
