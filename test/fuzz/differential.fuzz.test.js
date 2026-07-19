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
 * Fuzz Tests: Differential Execution (cross-process; seed-replay)
 *
 * The consensus contract of the VM is bit-identical execution on every
 * validator regardless of arch / Node ABI / libc. This suite fuzzes that
 * contract locally along the two axes reachable in a single CI job:
 *
 *   1. SEED REPLAY: the random corpus is a pure function of its seed, so a
 *      second independent run of the same seed must reproduce every
 *      consensus hash. This is what makes the cross-arch manifest diff
 *      (differential-run.js) sound: both arches sample the SAME inputs.
 *
 *   2. IN-PROCESS vs SUBPROCESS: production runs `execution:'subprocess'`
 *      (fork-isolated worker) while the unit/fuzz suites run in-process.
 *      Those are different V8 entry paths plus an IPC serialisation boundary,
 *      i.e. the nearest thing to a second "build" available in one job. Every
 *      generated case must hash identically across the two.
 *
 *   3. REFERENCE MANIFEST (optional): if a cross-arch reference manifest has
 *      been committed, this platform must reproduce it. Absent the file the
 *      case self-skips so the suite bootstraps cleanly on a fresh checkout.
 *
 * The true cross-ARCH differential runs in CI across a runner matrix; see
 * .github/workflows/vm-differential-fuzz.yml.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { XChainVM } = require('./harness');
const {
    DEFAULT_SEED,
    buildCorpus,
    runCorpus,
    buildManifest,
    diffManifests
} = require('./differential');

// Keep the in-suite corpus modest so the fuzz job stays fast; CI can widen it
// via DIFF_CASES, and the standalone runner defaults higher (200).
const DIFF_CASES = parseInt(process.env.DIFF_CASES || '60', 10);
const SEED = process.env.DIFF_SEED ? parseInt(process.env.DIFF_SEED, 10) : DEFAULT_SEED;
const REFERENCE_PATH = path.join(__dirname, 'differential-reference.json');

function firstDivergences(divs, n) {
    return divs.slice(0, n).map(d => '  - ' + d.detail).join('\n');
}

(XChainVM ? describe : describe.skip)('Fuzz: Differential execution', function () {
    this.timeout(180000);

    before(function () {
        // eslint-disable-next-line no-console -- record the corpus params so a red run is reproducible
        console.log(`        [differential] seed=${SEED} cases=${DIFF_CASES}` +
            (process.env.DIFF_SEED ? ' (pinned via DIFF_SEED)' : ' (default seed)'));
    });

    it('the corpus is a pure function of the seed (identical across two builds)', function () {
        const a = buildCorpus({ seed: SEED, cases: DIFF_CASES });
        const b = buildCorpus({ seed: SEED, cases: DIFF_CASES });
        assert.strictEqual(a.length, b.length, 'corpus size must be seed-stable');
        for (let i = 0; i < a.length; i++) {
            assert.strictEqual(a[i].code, b[i].code,
                `case ${i} code is not seed-stable; the differential would compare different inputs`);
            assert.deepStrictEqual(a[i].params, b[i].params, `case ${i} params not seed-stable`);
            assert.deepStrictEqual(a[i].state, b[i].state, `case ${i} state not seed-stable`);
        }
        // A different seed must actually move the corpus (guards against a
        // generator that ignores the seed and silently makes the diff vacuous).
        const other = buildCorpus({ seed: SEED + 1, cases: DIFF_CASES });
        const same = a.every((c, i) => c.code === other[i].code);
        assert.ok(!same, 'a different seed produced an identical corpus; sampling ignores the seed');
    });

    it('seed replay reproduces every consensus hash (in-process, two runs)', async function () {
        const corpus = buildCorpus({ seed: SEED, cases: DIFF_CASES });
        const run1 = await runCorpus(corpus, { execution: 'in-process' });
        const run2 = await runCorpus(corpus, { execution: 'in-process' });
        const m1 = { seed: SEED, cases: DIFF_CASES, platform: 'run1', entries: run1 };
        const m2 = { seed: SEED, cases: DIFF_CASES, platform: 'run2', entries: run2 };
        const divs = diffManifests(m1, m2);
        assert.strictEqual(divs.length, 0,
            `seed replay diverged on ${divs.length} case(s) - the corpus is not deterministic:\n` +
            firstDivergences(divs, 10));
    });

    it('in-process and subprocess execution agree on every case', async function () {
        const corpus = buildCorpus({ seed: SEED, cases: DIFF_CASES });
        const inProc = await runCorpus(corpus, { execution: 'in-process' });
        const subProc = await runCorpus(corpus, { execution: 'subprocess' });
        const mi = { seed: SEED, cases: DIFF_CASES, platform: 'in-process', entries: inProc };
        const ms = { seed: SEED, cases: DIFF_CASES, platform: 'subprocess', entries: subProc };
        const divs = diffManifests(mi, ms);
        assert.strictEqual(divs.length, 0,
            `${divs.length} case(s) diverged between in-process and subprocess execution ` +
            `(IPC / worker build boundary introduced non-determinism):\n` +
            firstDivergences(divs, 10));
    });

    it('reproduces the committed cross-arch reference manifest (if present)', async function () {
        if (!fs.existsSync(REFERENCE_PATH)) {
            // Bootstrap: no reference committed yet. Generate one on the
            // canonical arch with `differential-run.js record` and commit it.
            this.skip();
            return;
        }
        const ref = JSON.parse(fs.readFileSync(REFERENCE_PATH, 'utf8'));
        const live = await buildManifest({
            seed: ref.seed, cases: ref.cases, execution: 'in-process'
        });
        const divs = diffManifests(ref, live);
        assert.strictEqual(divs.length, 0,
            `this platform (${live.platform}) diverged from the reference ` +
            `manifest (${ref.platform}) on ${divs.length} case(s); a validator on ` +
            `this build would fork:\n` + firstDivergences(divs, 10));
    });
});
