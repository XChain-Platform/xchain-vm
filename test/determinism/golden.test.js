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
 * Golden-hash determinism guard.
 *
 * Re-executes the corpus on THIS machine/arch/Node and asserts every
 * INVARIANT-tier scenario reproduces the hash committed in
 * golden-manifest.json. A mismatch here on a validator means that
 * validator would disagree with the fleet → chain split. Run this in CI
 * on x86_64 and on every node version the fleet may run.
 *
 * RESOURCE-tier scenarios, the memory ceiling included, are asserted
 * byte-equal too: a resource termination clamps gasUsed to the ceiling,
 * empties state and emissions, and hashes under one folded error class,
 * so whichever ceiling fires first the consensus-visible result is fixed.
 * The point is to surface, loudly, if a resource outcome silently changes.
 ********************************************************************/
// @ts-nocheck


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runAll, platformTag } = require('./helpers/runner.js');
const { XChainVM } = require('../fuzz/helpers/harness.js');

const MANIFEST_PATH = path.join(__dirname, './golden-manifest.json');
let manifest;
let live;
let manifestLoad;

async function loadGoldenManifest() {
    if (!manifestLoad) {
        manifestLoad = initializeGoldenManifest();
    }
    await manifestLoad;
}

async function initializeGoldenManifest() {
    assert.ok(
        fs.existsSync(MANIFEST_PATH),
        'golden-manifest.json missing; generate it once with ' +
        '`node test/determinism/helpers/generate_golden.js`'
    );
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const res = await runAll();
    live = new Map(res.entries.map(e => [e.id, e]));
    // eslint-disable-next-line no-console -- intentional test progress output
    console.log(`        [determinism] verifying on ${platformTag()} ` +
        `against manifest generated on ${manifest.generatedOn}`);
}

describe('determinism: golden-hash manifest', function () {
    this.timeout(60000);

    if (!XChainVM) {
        it('REQUIRES isolated-vm (run under the validator Node version)', function () {
            // Fail loudly rather than silently skip. A "pending" determinism
            // guard is worse than useless: it looks like coverage that isn't.
            assert.fail(
                'isolated-vm failed to load. The determinism guard cannot run. ' +
                'Use the canonical runtime (Node 22, the validator ABI) and ' +
                '`npm rebuild isolated-vm --build-from-source`.'
            );
        });
        return;
    }

    before(loadGoldenManifest);

    it('manifest covers every executed scenario (no silent drift in the corpus)', function () {
        const manifestIds = new Set(manifest.scenarios.map(s => s.id));
        for (const id of live.keys()) {
            assert.ok(manifestIds.has(id),
                `scenario "${id}" is executed but missing from the manifest; ` +
                'regenerate the golden manifest');
        }
        assert.strictEqual(manifest.scenarios.length, live.size,
            'manifest scenario count differs from executed count');
    });
});

if (XChainVM) {
    describe('determinism: golden-hash manifest', function () {
        this.timeout(60000);
        before(loadGoldenManifest);

        describe('invariant tier: MUST be byte-identical across all platforms', function () {
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
    });

    describe('determinism: golden-hash manifest', function () {
        this.timeout(60000);
        before(loadGoldenManifest);

        describe('resource tier: failure shape must stay deterministic', function () {
            const resources = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
                .scenarios.filter(s => s.tier === 'resource');
            for (const sc of resources) {
                it(`${sc.id} fails the same way (${sc.hazard ? 'hazard: ' + sc.hazard : 'bounded'})`, function () {
                    const got = live.get(sc.id);
                    assert.ok(got, `scenario "${sc.id}" did not execute`);
                    // Hold every resource ceiling to the invariant standard: gas, memory and
                    // wall-clock terminations all clamp gasUsed to the ceiling, drop state and
                    // emissions, and hash under one folded error class, so any byte drift forks.
                    assert.strictEqual(got.hash, sc.hash,
                        `RESOURCE DETERMINISM BREAK on "${sc.id}": a resource ` +
                        `ceiling produced a different result than the manifest ` +
                        `(manifest gasUsed=${sc.gasUsed} error=${JSON.stringify(sc.error)}, ` +
                        `live gasUsed=${got.gasUsed} error=${JSON.stringify(got.error)}). ` +
                        `Resource terminations must be platform-independent.`);
                });
            }
        });
    });
}
