#!/usr/bin/env node
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

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ALWAYS = ['test/preflight.test.js'];
const WIDEN = ['test/fixtures/'];
const CONTROL_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const GROUP_ARGS = ['--timeout', '60000', '--exit'];

function normalizeFile(file) {
    return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function isConsensusPath(file) {
    if (file.startsWith('src/') && !file.startsWith('src/toolkit/')) return true;
    if (file.startsWith('bin/pins/')) return true;
    if (file === 'bin/pin_identity.js' || file === 'bin/lint.js') return true;
    if (WIDEN.some((prefix) => file.startsWith(prefix))) return true;
    return CONTROL_FILES.has(file);
}

function isGroupTest(file) {
    if (file === 'test/preflight.test.js') return true;
    if (/^test\/(unit|smoke|security|boundary|determinism|toolkit|integration|chaos)\/.+\.test\.js$/.test(file)) return true;
    if (/^test\/known_red\/[^/]+\.test\.js$/.test(file)) return true;
    if (/^test\/regression\/[^/]+_regression\.test\.js$/.test(file)) return true;
    if (/^test\/regression\/[^/]+_regression\.test\/.+\.test\.js$/.test(file)) return true;
    if (/^test\/regression\/determinism\.test\/.+\.js$/.test(file)) return true;
    return file === 'test/regression/determinism.test.js'
        || file === 'test/regression/determinism_baseline.test.js';
}

function isTestFile(file) {
    return file.startsWith('test/') && /\.(test|fuzz)\.js$/.test(file);
}

function directDirectoryMatch(testFile, sourceFile) {
    const sourceDir = path.posix.dirname(sourceFile.slice('src/'.length));
    if (sourceDir === '.') return /^test\/[^/]+\/[^/]+$/.test(testFile);
    const parts = testFile.split('/');
    const expected = sourceDir.split('/');
    return parts.length === expected.length + 3
        && parts.slice(2, -1).join('/') === sourceDir;
}

function sourceMatches(testFile, sourceFile) {
    const stem = path.posix.basename(sourceFile, '.js');
    if (stem !== 'index' && path.posix.basename(testFile) === `${stem}.test.js`) return true;
    if (stem !== 'index' && testFile.includes(`/${stem}.test/`)) return true;
    return directDirectoryMatch(testFile, sourceFile);
}

function uniqueSorted(values) {
    return [...new Set(values)].sort();
}

function selectFastTests(changedFiles, { listTests, findRequirers }) {
    const changed = uniqueSorted(changedFiles.map(normalizeFile));
    const available = uniqueSorted(listTests().map(normalizeFile)).filter(isGroupTest);
    const availableSet = new Set(available);
    const reasons = [];
    const selected = new Set(ALWAYS.filter((file) => availableSet.has(file)));

    for (const file of changed) {
        if (isConsensusPath(file)) reasons.push(`consensus: ${file}`);
        if (isTestFile(file) && !isGroupTest(file)) reasons.push(`deferred: ${file}`);
        if (isGroupTest(file) && availableSet.has(file)) selected.add(file);
    }

    for (const sourceFile of changed.filter((file) => file.startsWith('src/') && file.endsWith('.js'))) {
        const importers = findRequirers(sourceFile, { relativeOnly: true }).map(normalizeFile);
        for (const importer of importers.filter(isConsensusPath)) {
            reasons.push(`consensus importer: ${importer}`);
        }
        for (const testFile of available) {
            if (sourceMatches(testFile, sourceFile)) selected.add(testFile);
        }
        const namedTests = findRequirers(sourceFile, { moduleTail: true }).map(normalizeFile);
        for (const testFile of namedTests) {
            if (availableSet.has(testFile)) selected.add(testFile);
        }
    }

    const sortedReasons = uniqueSorted(reasons);
    return {
        consensus: sortedReasons.some((reason) => reason.startsWith('consensus')),
        reasons: sortedReasons,
        tests: uniqueSorted([...selected]).map((file) => ({ group: 'ci', file })),
    };
}

function callGit(git, args) {
    return String(git(args) || '').trim();
}

function resolveBase({ env, git }) {
    const supplied = env.PROM_CI_BASE_SHA;
    if (supplied) {
        try {
            callGit(git, ['cat-file', '-e', `${supplied}^{commit}`]);
            return supplied;
        } catch (_) {
            // Fall through to the shared branch when a venue base is stale.
        }
    }
    try {
        return callGit(git, ['merge-base', 'HEAD', 'origin/develop']) || null;
    } catch (_) {
        return null;
    }
}

function runGit(args) {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function listTests() {
    const output = runGit(['ls-files', 'test']);
    return output.split('\n').filter(Boolean).filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
}

function grepFiles(needle) {
    try {
        const output = runGit(['grep', '-l', '-F', '--', needle, '--', '*.js']);
        return output.split('\n').filter(Boolean);
    } catch (error) {
        if (error.status === 1) return [];
        throw error;
    }
}

function requireTargets(file) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const targets = [];
    const requirePattern = /require\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    for (const match of text.matchAll(requirePattern)) {
        const absolute = path.resolve(REPO_ROOT, path.dirname(file), match[1]);
        targets.push(absolute, `${absolute}.js`, path.join(absolute, 'index.js'));
    }
    return targets.map((target) => normalizeFile(path.relative(REPO_ROOT, target)));
}

function findRequirers(sourceFile, options = {}) {
    const normalized = normalizeFile(sourceFile);
    const moduleTail = normalized.replace(/\.js$/, '');
    if (options.moduleTail) return grepFiles(moduleTail);
    const candidates = grepFiles(path.posix.basename(normalized));
    return candidates.filter((file) => requireTargets(file).includes(normalized));
}

function noBaseReason(env) {
    if (env.PROM_CI_BASE_SHA) return `invalid ${env.PROM_CI_BASE_SHA}; merge-base failed`;
    return 'merge-base with origin/develop failed';
}

function computePlan(env) {
    const base = resolveBase({ env, git: runGit });
    if (!base) return { noBase: noBaseReason(env) };
    const output = runGit(['diff', '--name-only', `${base}...HEAD`]);
    const changedFiles = output.split('\n').filter(Boolean);
    return selectFastTests(changedFiles, { listTests, findRequirers });
}

function printPlan(plan) {
    if (plan.noBase) {
        process.stdout.write(`no-base ${plan.noBase}\n`);
        return;
    }
    process.stdout.write(`consensus ${plan.consensus ? 1 : 0}\n`);
    for (const reason of plan.reasons) process.stdout.write(`reason ${reason}\n`);
    for (const test of plan.tests) process.stdout.write(`test ${test.group} ${test.file}\n`);
}

function runPlan(plan) {
    const files = plan.tests.filter((test) => test.group === 'ci').map((test) => test.file);
    if (files.length === 0) {
        process.stdout.write('ci:fast: no test maps to this push\n');
        return 0;
    }
    const mocha = path.join(REPO_ROOT, 'node_modules/.bin/mocha');
    const result = spawnSync(mocha, ['--no-config', ...GROUP_ARGS, ...files], {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: 'inherit',
    });
    if (result.error || result.signal) return 1;
    return result.status || 0;
}

function main() {
    const mode = process.argv[2];
    if (mode !== '--plan' && mode !== '--run') {
        process.stderr.write('usage: node bin/ci_fast_select.js --plan|--run\n');
        return 2;
    }
    try {
        const plan = computePlan(process.env);
        if (plan.noBase) {
            printPlan(plan);
            return 3;
        }
        if (mode === '--plan') {
            printPlan(plan);
            return 0;
        }
        return runPlan(plan);
    } catch (error) {
        process.stderr.write(`selector-error ${String(error.message).split('\n')[0]}\n`);
        return 2;
    }
}

module.exports = { resolveBase, selectFastTests, listTests, findRequirers };

if (require.main === module) process.exitCode = main();
