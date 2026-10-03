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
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
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

function scratchGit(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeScratchFile(cwd, file, source) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
}

function scratchCommit(cwd, message, changedFiles) {
    scratchGit(cwd, ['add', '--', ...changedFiles]);
    scratchGit(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message,
    ]);
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

    it('widens changed fixtures without treating them as consensus importers', () => {
        const changedFixture = selectFastTests(['test/fixtures/program.js'], {
            listTests: () => ['test/preflight.test.js'],
            findRequirers: () => [],
        });
        const plan = selectFastTests(['src/toolkit/gate.js'], {
            listTests: () => ['test/preflight.test.js'],
            findRequirers: (_file, options) => options.relativeOnly ? ['test/fixtures/program.js'] : [],
        });
        assert.strictEqual(changedFixture.consensus, true);
        assert.strictEqual(plan.consensus, false);
        assert(!plan.reasons.some((reason) => reason.includes('test/fixtures/program.js')));
    });

    it('finds extensionless relative requires', () => {
        const sourceFile = ['src/metering', 'js'].join('.');
        const requirers = findRequirers(sourceFile, { relativeOnly: true });
        assert(requirers.includes('test/unit/metering/contract_language_version.test.js'));
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

    it('replays develop history, compares narrowing, and checks required selections', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'));
        try {
            scratchGit(cwd, ['init', '--initial-branch=develop']);
            const initial = {
                'src/consensus/rule.js': "module.exports = 'rule';\n",
                'src/toolkit/plain.js': "module.exports = 'plain';\n",
                'test/unit/consensus/rule.test.js':
                    "require('../../../src/consensus/rule');\n",
                'test/unit/toolkit/plain.test.js': "require('../../../src/toolkit/plain');\n",
                'test/unit/only.test.js': "module.exports = 'only';\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated';\n",
            };
            for (const [file, source] of Object.entries(initial)) writeScratchFile(cwd, file, source);
            scratchCommit(cwd, 'initial files', Object.keys(initial));

            const consensusFile = 'src/consensus/rule.js';
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'consensus change', [consensusFile]);

            const plainFile = 'src/toolkit/plain.js';
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'plain source change', [plainFile]);

            const testFile = 'test/unit/only.test.js';
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'test only change', [testFile]);
            scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

            const selector = path.resolve(__dirname, '../ci_fast_select.js');
            const mustSelect = [
                'src/consensus/rule.js:test/unit/consensus/rule.test.js',
                'src/toolkit/plain.js:test/unit/other/unrelated.test.js',
            ].join(',');
            const result = spawnSync(process.execPath, [
                selector,
                '--replay', '3',
                '--narrow', 'src/consensus/',
                '--must-select', mustSelect,
            ], { cwd, encoding: 'utf8' });

            assert.strictEqual(result.status, 1, result.stderr);
            const lines = result.stdout.trim().split(/\r?\n/);
            assert(lines.includes('plan commits consensus-1 changed-tests test-only no-tests'));
            assert(lines.includes('current 3 1/3 1/3 1/3 0/3'));
            assert(lines.includes('narrowed 3 0/3 2/3 1/3 0/3'));
            assert(lines.includes(
                'must-select PASS src/consensus/rule.js:test/unit/consensus/rule.test.js'));
            assert(lines.includes(
                'must-select FAIL src/toolkit/plain.js:test/unit/other/unrelated.test.js'));
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
