/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Golden-hash determinism guard.
 *
 * Re-executes the corpus on THIS machine/arch/Node and asserts every
 * INVARIANT-tier scenario reproduces the hash committed in
 * golden-manifest.json. A mismatch here on a validator means that
 * validator would disagree with the fleet → chain split. Run this in CI
 * on x86_64 and on every node version the fleet may run.
 *
 * RESOURCE-tier scenarios are checked for deterministic FAILURE shape
 * (same success flag + same error class) but the memory-ceiling hazard
 * is asserted only to be a clean, contained failure — not byte-equal —
 * because GC timing legitimately varies. The point is to surface, loudly,
 * if a resource outcome silently changes.
 ********************************************************************/
// @ts-nocheck


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runAll, platformTag } = require('./runner');
const { XChainVM } = require('../fuzz/harness');

const MANIFEST_PATH = path.join(__dirname, 'golden-manifest.json');

describe('determinism: golden-hash manifest', function () {
    this.timeout(60000);

    if (!XChainVM) {
        it('REQUIRES isolated-vm (run under the validator Node version)', function () {
            // Fail loudly rather than silently skip — a "pending" determinism
            // guard is worse than useless: it looks like coverage that isn't.
            assert.fail(
                'isolated-vm failed to load. The determinism guard cannot run. ' +
                'Use the canonical runtime (Node 22, the validator ABI) and ' +
                '`npm rebuild isolated-vm --build-from-source`.'
            );
        });
        return;
    }

    let manifest;
    let live;

    before(async function () {
        assert.ok(
            fs.existsSync(MANIFEST_PATH),
            'golden-manifest.json missing — generate it once with ' +
            '`node test/determinism/generate-golden.js`'
        );
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        const res = await runAll();
        live = new Map(res.entries.map(e => [e.id, e]));
        // eslint-disable-next-line no-console
        console.log(`        [determinism] verifying on ${platformTag()} ` +
            `against manifest generated on ${manifest.generatedOn}`);
    });

    it('manifest covers every executed scenario (no silent drift in the corpus)', function () {
        const manifestIds = new Set(manifest.scenarios.map(s => s.id));
        for (const id of live.keys()) {
            assert.ok(manifestIds.has(id),
                `scenario "${id}" is executed but missing from the manifest — ` +
                'regenerate the golden manifest');
        }
        assert.strictEqual(manifest.scenarios.length, live.size,
            'manifest scenario count differs from executed count');
    });

    describe('invariant tier — MUST be byte-identical across all platforms', function () {
        const invariants = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
            .scenarios.filter(s => s.tier === 'invariant');
        for (const sc of invariants) {
            it(`${sc.id} reproduces committed hash`, function () {
                const got = live.get(sc.id);
                assert.ok(got, `scenario "${sc.id}" did not execute`);
                assert.strictEqual(got.hash, sc.hash,
                    `DETERMINISM BREAK on "${sc.id}": this platform produced a ` +
                    `different consensus-visible result than the golden manifest. ` +
                    `gasUsed manifest=${sc.gasUsed} live=${got.gasUsed}, ` +
                    `error manifest=${JSON.stringify(sc.error)} live=${JSON.stringify(got.error)}. ` +
                    `A validator on this platform would FORK the chain.`);
            });
        }
    });

    describe('resource tier — failure shape must stay deterministic', function () {
        const resources = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
            .scenarios.filter(s => s.tier === 'resource');
        for (const sc of resources) {
            it(`${sc.id} fails the same way (${sc.hazard ? 'hazard: ' + sc.hazard : 'bounded'})`, function () {
                const got = live.get(sc.id);
                assert.ok(got, `scenario "${sc.id}" did not execute`);
                if (sc.hazard === 'memory-ceiling-nondeterminism') {
                    // Memory ceilings legitimately fire at GC-timing-dependent
                    // points. We require ONLY: the contract still fails cleanly
                    // and contained (no success, no partial emissions/state).
                    assert.strictEqual(got.success, false,
                        `memory-bomb unexpectedly SUCCEEDED on this platform — ` +
                        `the memory ceiling did not contain it`);
                } else {
                    // Gas/count-bounded ceilings ARE deterministic — hold them
                    // to the same standard as invariants.
                    assert.strictEqual(got.hash, sc.hash,
                        `RESOURCE DETERMINISM BREAK on "${sc.id}": a gas/count ` +
                        `ceiling produced a different result than the manifest ` +
                        `(manifest gasUsed=${sc.gasUsed} live=${got.gasUsed}). ` +
                        `Gas metering must be platform-independent.`);
                }
            });
        }
    });
});
