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
 * Differential-fuzz leg identity check: the diff job's refusal of a missing,
 * duplicated, mislabelled or off-pin leg. Synthetic manifests only; the
 * engine is never loaded.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PINNED } = require('../../../src/consensus-runtime.js');
const {
    EXPECTED_LEGS,
    manifestFileName,
    checkLegManifest,
    checkLegSet
} = require('../../fuzz/helpers/differential_legs.js');

const RUNNER = path.join(__dirname, '../../fuzz/helpers/differential_run.js');
const SEED = 7;
const CASES = 2;
const TAGS = {
    'linux-x64-glibc':   `linux-x64-node22-v8_${PINNED.v8}-glibc2.39`,
    'linux-arm64-glibc': `linux-arm64-node22-v8_${PINNED.v8}-glibc2.39`,
    'linux-x64-musl':    `linux-x64-node22-v8_${PINNED.v8}-nonglibc`
};

function manifest(leg, over) {
    return Object.assign({
        version: 1,
        kind: 'vm-differential-fuzz-manifest',
        seed: SEED,
        cases: CASES,
        execution: 'in-process',
        platform: TAGS[leg],
        node: '22.22.3',
        entries: [{ index: 0, resultHash: 'a' }, { index: 1, resultHash: 'b' }],
        consensusRuntime: { ok: true, mismatches: [] }
    }, over || {});
}

function writeLegs(dir, overrides, profile) {
    for (const leg of Object.keys(EXPECTED_LEGS)) {
        const over = (overrides || {})[leg];
        if (over === null) continue;
        fs.writeFileSync(path.join(dir, manifestFileName(profile || 'legacy', leg)),
            JSON.stringify(manifest(leg, over)));
    }
}

describe('differential-fuzz leg identity check', function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-legs-')); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it('passes three present, distinct, pinned legs', function () {
        writeLegs(dir);
        assert.deepStrictEqual(checkLegSet(dir, { seed: SEED, cases: CASES }), []);
    });

    it('fails when the musl leg left no manifest', function () {
        writeLegs(dir, { 'linux-x64-musl': null });
        const p = checkLegSet(dir, { seed: SEED, cases: CASES });
        assert.ok(p.some(x => /linux-x64-musl: manifest missing/.test(x)), p.join('\n'));
    });

    it('fails a musl leg that recorded a glibc platform', function () {
        writeLegs(dir, { 'linux-x64-musl': { platform: `linux-x64-node22-v8_${PINNED.v8}-glibc2.39` } });
        const p = checkLegSet(dir, { seed: SEED, cases: CASES });
        assert.ok(p.some(x => /linux-x64-musl: platform .* does not match/.test(x)), p.join('\n'));
    });

    it('fails an arm64 leg that recorded an x64 platform', function () {
        assert.ok(checkLegManifest('linux-arm64-glibc',
            manifest('linux-arm64-glibc', { platform: TAGS['linux-x64-glibc'] })).length > 0);
    });

    it('fails two legs reporting one platform tag', function () {
        writeLegs(dir, { 'linux-arm64-glibc': { platform: TAGS['linux-x64-glibc'] } });
        const p = checkLegSet(dir, { seed: SEED, cases: CASES });
        assert.ok(p.some(x => /same platform tag as linux-x64-glibc/.test(x)), p.join('\n'));
    });

    it('fails an off-pin or unrecorded consensus runtime', function () {
        const off = { ok: false, mismatches: [{ key: 'v8', expected: PINNED.v8, actual: '12.4.254.99' }] };
        assert.ok(checkLegManifest('linux-x64-glibc', manifest('linux-x64-glibc', { consensusRuntime: off }))
            .some(x => /off-pin/.test(x)));
        assert.ok(checkLegManifest('linux-x64-glibc', manifest('linux-x64-glibc', { consensusRuntime: undefined }))
            .some(x => /no consensusRuntime/.test(x)));
    });

    it('fails a seed or cases mismatch and an empty entry list', function () {
        const leg = 'linux-x64-glibc';
        assert.ok(checkLegManifest(leg, manifest(leg, { seed: 8 }), { seed: SEED }).length > 0);
        assert.ok(checkLegManifest(leg, manifest(leg, { cases: 3 }), { cases: CASES }).length > 0);
        assert.ok(checkLegManifest(leg, manifest(leg, { entries: [] })).some(x => /no entries/.test(x)));
    });
});

describe('differential-fuzz leg identity check', function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-legs-')); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it('fails a V8 build other than the pinned engine', function () {
        const leg = 'linux-x64-glibc';
        const p = checkLegManifest(leg, manifest(leg, { platform: 'linux-x64-node22-v8_12.4.254.99-node.1-glibc2.39' }));
        assert.ok(p.some(x => /pinned/.test(x)), p.join('\n'));
    });

    it('fails an unknown leg name', function () {
        assert.deepStrictEqual(checkLegManifest('darwin-arm64', manifest('linux-x64-glibc')), ['unknown leg "darwin-arm64"']);
    });

    it('checks a post-gate leg set by its own file names and targeted count', function () {
        const pg = { profile: 'post-gate', targeted: 1, entries: [{ index: 0 }, { index: 1 }, { index: 1000000 }] };
        writeLegs(dir, { 'linux-x64-glibc': pg, 'linux-arm64-glibc': pg, 'linux-x64-musl': pg }, 'post-gate');
        assert.deepStrictEqual(checkLegSet(dir, { seed: SEED, cases: CASES, profile: 'post-gate' }), []);
        assert.ok(checkLegSet(dir, { seed: SEED, cases: CASES }).some(x => /manifest missing/.test(x)));
        const regime = Object.assign({}, pg, { regime: ['mainnet:parse@257: expected out_of_stack, got success'] });
        assert.ok(checkLegManifest('linux-x64-glibc', manifest('linux-x64-glibc', regime), { profile: 'post-gate' })
            .some(x => /not in the post-gate regime/.test(x)));
    });

    it('check-legs exits non-zero on a missing leg and zero on a full set', function () {
        writeLegs(dir, { 'linux-arm64-glibc': null });
        assert.throws(() => execFileSync(process.execPath, [RUNNER, 'check-legs', dir, '--seed', String(SEED)],
            { stdio: 'pipe' }), (e) => e.status === 1 && /linux-arm64-glibc: manifest missing/.test(String(e.stderr)));
        writeLegs(dir);
        execFileSync(process.execPath, [RUNNER, 'check-legs', dir, '--seed', String(SEED), '--cases', String(CASES)],
            { stdio: 'pipe' });
    });
});
