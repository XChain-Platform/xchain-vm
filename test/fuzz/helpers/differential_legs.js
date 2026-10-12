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
 * Differential-fuzz leg identity check.
 *
 * The cross-build differential is only as strong as the set of legs it
 * compares. A manifest glob shrinks silently when a matrix leg is dropped, and
 * a leg whose container stanza is lost records glibc while still being named
 * "musl". This module pins the expected leg set and checks each leg's manifest
 * against the platform it claims to be and against the pinned consensus
 * engine, so the diff job refuses a run that would compare less than it says.
 *
 * Pure: reads manifests from disk only in checkLegSet, never loads the VM.
 ********************************************************************/
// @ts-nocheck

const fs = require('fs');
const path = require('path');
const { PINNED } = require('../../../src/consensus-runtime.js');

const REFERENCE_LEG = 'linux-x64-glibc';

// Leg name -> the platformTag() shape that leg must record. The capture group
// is the V8 build string, checked against the pinned engine separately.
const EXPECTED_LEGS = Object.freeze({
    'linux-x64-glibc':   /^linux-x64-node22-v8_(.+)-glibc[0-9.]+$/,
    'linux-arm64-glibc': /^linux-arm64-node22-v8_(.+)-glibc[0-9.]+$/,
    'linux-x64-musl':    /^linux-x64-node22-v8_(.+)-nonglibc$/
});

const MANIFEST_PREFIX = Object.freeze({
    'legacy':    'differential',
    'post-gate': 'differential-postgate'
});

function manifestFileName(profile, leg) {
    const prefix = MANIFEST_PREFIX[profile];
    if (!prefix) throw new Error(`unknown differential profile: ${profile}`);
    return `${prefix}.${leg}.json`;
}

// Check one leg's manifest; returns a list of problems (empty means OK).
function checkLegManifest(leg, manifest, expected) {
    const pattern = EXPECTED_LEGS[leg];
    if (!pattern) return [`unknown leg "${leg}"`];
    if (!manifest || typeof manifest !== 'object') return [`${leg}: manifest is not an object`];
    const want = expected || {};
    const problems = [];
    if (manifest.kind !== 'vm-differential-fuzz-manifest') problems.push(`${leg}: kind is ${JSON.stringify(manifest.kind)}`);
    if (want.seed != null && manifest.seed !== want.seed) problems.push(`${leg}: seed ${manifest.seed}, expected ${want.seed}`);
    if (want.cases != null && manifest.cases !== want.cases) problems.push(`${leg}: cases ${manifest.cases}, expected ${want.cases}`);
    const profile = manifest.profile || 'legacy';
    if (want.profile != null && profile !== want.profile) problems.push(`${leg}: profile ${profile}, expected ${want.profile}`);
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const extra = profile === 'post-gate' ? manifest.targeted : 0;
    if (profile === 'post-gate' && !(extra > 0)) problems.push(`${leg}: post-gate manifest has no targeted cases`);
    if (entries.length === 0) problems.push(`${leg}: no entries`);
    else if (entries.length !== manifest.cases + (extra || 0)) problems.push(`${leg}: ${entries.length} entries for ${manifest.cases} cases`);
    if (Array.isArray(manifest.regime) && manifest.regime.length) problems.push(`${leg}: not in the post-gate regime: ${manifest.regime.join('; ')}`);
    const rt = manifest.consensusRuntime;
    if (!rt || typeof rt !== 'object') problems.push(`${leg}: no consensusRuntime verdict (record without --require-pinned-runtime?)`);
    else if (rt.ok !== true) problems.push(`${leg}: consensus runtime off-pin: ${JSON.stringify(rt.mismatches || [])}`);
    const m = pattern.exec(String(manifest.platform || ''));
    if (!m) problems.push(`${leg}: platform ${JSON.stringify(manifest.platform)} does not match ${pattern}`);
    else if (m[1] !== PINNED.v8) problems.push(`${leg}: V8 ${m[1]}, pinned ${PINNED.v8}`);
    return problems;
}

// Load and check every expected leg of one profile from a manifest directory.
// Also refuses two legs reporting one platform tag (a leg that is a copy of
// another compares a build against itself).
function checkLegSet(dir, expected) {
    const want = Object.assign({ profile: 'legacy' }, expected || {});
    const problems = [];
    const seenPlatform = new Map();
    for (const leg of Object.keys(EXPECTED_LEGS)) {
        const file = path.join(dir, manifestFileName(want.profile, leg));
        if (!fs.existsSync(file)) { problems.push(`${leg}: manifest missing (${file})`); continue; }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            problems.push(`${leg}: manifest unreadable (${e.message})`);
            continue;
        }
        problems.push(...checkLegManifest(leg, manifest, want));
        const tag = manifest.platform;
        if (seenPlatform.has(tag)) problems.push(`${leg}: same platform tag as ${seenPlatform.get(tag)} (${tag})`);
        else seenPlatform.set(tag, leg);
    }
    return problems;
}

module.exports = {
    REFERENCE_LEG,
    EXPECTED_LEGS,
    MANIFEST_PREFIX,
    manifestFileName,
    checkLegManifest,
    checkLegSet
};
