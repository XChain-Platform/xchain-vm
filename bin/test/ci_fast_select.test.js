/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
    resolveBase,
    selectFastTests,
    listTests,
    findRequirers,
} = require('../ci_fast_select.js');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REAL_TREE = { listTests, findRequirers };

function select(changedFiles) {
    return selectFastTests(changedFiles, REAL_TREE);
}

function files(plan) {
    return plan.tests.map((test) => test.file);
}

describe('bin/ci_fast_select.js', () => {
    it('maps toolkit authoring changes to its complete split suite and preflight', () => {
        const plan = select(['src/toolkit/authoring.js']);
        const selected = files(plan);
        const splitTests = execFileSync('git', ['ls-files', 'test/toolkit/authoring.test/*.test.js'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        }).trim().split('\n');

        assert.strictEqual(plan.consensus, false);
        assert(selected.includes('test/preflight.test.js'));
        assert(selected.includes('test/toolkit/authoring.test.js'));
        for (const testFile of splitTests) assert(selected.includes(testFile), testFile);
        assert(plan.tests.every((test) => test.group === 'ci'));
    });

    it('widens metering and sandbox changes to the consensus suite', () => {
        for (const changedFile of ['src/metering.js', 'src/sandbox.js']) {
            const plan = select([changedFile]);
            assert.strictEqual(plan.consensus, true, changedFile);
            assert(plan.reasons.some((reason) => reason.includes(changedFile)), changedFile);
        }
    });

    it('maps documentation-only changes to the always-on guard', () => {
        const plan = select(['README.md']);
        assert.strictEqual(plan.consensus, false);
        assert.deepStrictEqual(plan.tests, [{ group: 'ci', file: 'test/preflight.test.js' }]);
    });

    it('widens package metadata changes and names the path', () => {
        const plan = select(['package.json']);
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.some((reason) => reason.includes('package.json')));
    });

    it('widens a toolkit change required by a consensus module', () => {
        const plan = selectFastTests(['src/toolkit/gate.js'], {
            listTests: () => ['test/preflight.test.js'],
            findRequirers: (_file, options) => options.relativeOnly ? ['src/sandbox.js'] : [],
        });
        assert.strictEqual(plan.consensus, true);
        assert(plan.reasons.some((reason) => reason.includes('src/sandbox.js')));
    });

    it('defers a tracked performance test outside the ci group', () => {
        const changedFile = 'test/performance/throughput.test.js';
        assert(fs.existsSync(path.join(REPO_ROOT, changedFile)));
        const plan = select([changedFile]);
        assert.strictEqual(plan.consensus, false);
        assert(plan.reasons.includes(`deferred: ${changedFile}`));
        assert.deepStrictEqual(plan.tests, [{ group: 'ci', file: 'test/preflight.test.js' }]);
    });

    it('returns null when both supplied and fallback bases fail', () => {
        const git = (args) => {
            throw new Error(args.join(' '));
        };
        assert.strictEqual(resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git }), null);
    });

    it('returns a supplied base when git accepts its commit', () => {
        const calls = [];
        const git = (args) => {
            calls.push(args);
            return '';
        };
        const base = resolveBase({ env: { PROM_CI_BASE_SHA: 'abc123' }, git });
        assert.strictEqual(base, 'abc123');
        assert.deepStrictEqual(calls, [['cat-file', '-e', 'abc123^{commit}']]);
    });

    it('falls back to the develop merge base after rejecting a supplied base', () => {
        const git = (args) => {
            if (args[0] === 'cat-file') throw new Error('unknown commit');
            assert.deepStrictEqual(args, ['merge-base', 'HEAD', 'origin/develop']);
            return 'def456\n';
        };
        const base = resolveBase({ env: { PROM_CI_BASE_SHA: 'unknown' }, git });
        assert.strictEqual(base, 'def456');
    });

    it('keeps the full runner wiring and guards the selector by tier', () => {
        const script = fs.readFileSync(path.join(REPO_ROOT, 'bin/ci-full.sh'), 'utf8');
        assert(script.includes('ci_fast_select.js --plan'));
        assert(script.includes('CI_TIER'));
        assert(script.includes('npm run coverage:subprocess'));
    });
});
