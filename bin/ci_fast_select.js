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

function matchesNarrowPrefix(file, prefixes) {
    return prefixes.some((prefix) => {
        const trimmed = prefix.trim().replace(/\/$/, '');
        return trimmed && (file === trimmed || file.startsWith(`${trimmed}/`));
    });
}

function isConsensusCodePath(file, narrowPrefixes = []) {
    if (matchesNarrowPrefix(file, narrowPrefixes)) return false;
    if (file.startsWith('src/') && !file.startsWith('src/toolkit/')) return true;
    if (file.startsWith('bin/pins/')) return true;
    if (file === 'bin/pin_identity.js' || file === 'bin/lint.js') return true;
    return false;
}

function widensToConsensus(file, narrowPrefixes = []) {
    if (isConsensusCodePath(file, narrowPrefixes)) return true;
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

function selectFastTests(changedFiles, { listTests, findRequirers }, { narrowPrefixes = [] } = {}) {
    const changed = uniqueSorted(changedFiles.map(normalizeFile));
    const available = uniqueSorted(listTests().map(normalizeFile)).filter(isGroupTest);
    const availableSet = new Set(available);
    const reasons = [];
    const selected = new Set(ALWAYS.filter((file) => availableSet.has(file)));

    for (const file of changed) {
        if (widensToConsensus(file, narrowPrefixes)) reasons.push(`consensus: ${file}`);
        if (isTestFile(file) && !isGroupTest(file)) reasons.push(`deferred: ${file}`);
        if (isGroupTest(file) && availableSet.has(file)) selected.add(file);
    }

    for (const sourceFile of changed.filter((file) => file.startsWith('src/') && file.endsWith('.js'))) {
        const importers = findRequirers(sourceFile, { relativeOnly: true }).map(normalizeFile);
        for (const importer of importers.filter((file) => isConsensusCodePath(file, narrowPrefixes))) {
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

function runGitAt(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runGit(args) {
    return runGitAt(REPO_ROOT, args);
}

function listTestsAt(root) {
    const output = runGitAt(root, ['ls-files', 'test']);
    return output.split('\n').filter(Boolean).filter((file) => fs.existsSync(path.join(root, file)));
}

function listTests() {
    return listTestsAt(REPO_ROOT);
}

function grepFilesAt(root, needle) {
    try {
        const output = runGitAt(root, ['grep', '-l', '-F', '--', needle, '--', '*.js']);
        return output.split('\n').filter(Boolean);
    } catch (error) {
        if (error.status === 1) return [];
        throw error;
    }
}

function requireTargetsFromSource(root, file, text) {
    const targets = [];
    const requirePattern = /require\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    for (const match of text.matchAll(requirePattern)) {
        const absolute = path.resolve(root, path.dirname(file), match[1]);
        targets.push(absolute, `${absolute}.js`, path.join(absolute, 'index.js'));
    }
    return targets.map((target) => normalizeFile(path.relative(root, target)));
}

function requireTargetsAt(root, file) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return requireTargetsFromSource(root, file, text);
}

function findRequirersAt(root, sourceFile, options = {}) {
    const normalized = normalizeFile(sourceFile);
    const moduleTail = normalized.replace(/\.js$/, '');
    if (options.moduleTail) return grepFilesAt(root, moduleTail);
    const candidates = grepFilesAt(root, path.posix.basename(moduleTail));
    return candidates.filter((file) => requireTargetsAt(root, file).includes(normalized));
}

function findRequirers(sourceFile, options = {}) {
    return findRequirersAt(REPO_ROOT, sourceFile, options);
}

function gitLinesAt(root, args, allowNoMatches = false) {
    try {
        return runGitAt(root, args).split(/\r?\n/).filter(Boolean);
    } catch (error) {
        if (allowNoMatches && error.status === 1) return [];
        throw error;
    }
}

function selectionDependencies({ root = process.cwd(), indexed = false } = {}) {
    const tests = listTestsAt(root);
    if (!indexed) {
        return {
            listTests: () => tests,
            findRequirers: (file, options) => findRequirersAt(root, file, options),
        };
    }
    const files = gitLinesAt(root, ['ls-files']).filter((file) => {
        return file.endsWith('.js') && fs.existsSync(path.join(root, file));
    });
    const sources = new Map();
    const importers = new Map();
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        sources.set(file, source);
        for (const target of requireTargetsFromSource(root, file, source)) {
            if (!importers.has(target)) importers.set(target, []);
            importers.get(target).push(file);
        }
    }
    return {
        listTests: () => tests,
        findRequirers: (file, options = {}) => {
            const normalized = normalizeFile(file);
            if (!options.moduleTail) return importers.get(normalized) || [];
            const moduleTail = normalized.replace(/\.js$/, '');
            return [...sources].filter(([, source]) => source.includes(moduleTail)).map(([name]) => name);
        },
    };
}

function noBaseReason(env) {
    if (env.PROM_CI_BASE_SHA) return `invalid ${env.PROM_CI_BASE_SHA}; merge-base failed`;
    return 'merge-base with origin/develop failed';
}

function changedFilesForCommit(root, commit) {
    const revision = gitLinesAt(root, ['rev-list', '--parents', '-n', '1', commit])[0];
    const [, parent] = revision.split(' ');
    if (parent) return gitLinesAt(root, ['diff', '--name-only', `${parent}..${commit}`]);
    return gitLinesAt(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]);
}

function emptyReplayCounts() {
    return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 };
}

function countReplayPlan(counts, changed, plan) {
    if (plan.consensus) {
        counts.wholeUnit++;
    } else if (plan.tests.length && changed.every((file) => file.startsWith('test/'))) {
        counts.testOnly++;
    } else if (plan.tests.length) {
        counts.changedTests++;
    } else {
        counts.noTests++;
    }
}

function replayPlans(limit, narrowPrefixes) {
    const root = process.cwd();
    const commits = gitLinesAt(root, [
        'log', '--first-parent', '-n', String(limit), '--format=%H', 'origin/develop',
    ]);
    const current = emptyReplayCounts();
    const narrowed = emptyReplayCounts();
    const dependencies = selectionDependencies({ root, indexed: true });
    for (const commit of commits) {
        const changed = changedFilesForCommit(root, commit);
        countReplayPlan(current, changed, selectFastTests(changed, dependencies));
        countReplayPlan(narrowed, changed, selectFastTests(changed, dependencies, { narrowPrefixes }));
    }
    return { commits, current, narrowed, narrowPrefixes, dependencies };
}

function fraction(value, total) {
    return `${value}/${total}`;
}

function printReplayRow(name, total, counts) {
    process.stdout.write(`${[
        name,
        total,
        fraction(counts.wholeUnit, total),
        fraction(counts.changedTests, total),
        fraction(counts.testOnly, total),
        fraction(counts.noTests, total),
    ].join(' ')}\n`);
}

function parseList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseMustSelect(value) {
    return parseList(value).map((pair) => {
        const separator = pair.indexOf(':');
        if (separator <= 0 || separator === pair.length - 1) {
            throw new Error(`invalid --must-select pair: ${pair}`);
        }
        return { source: pair.slice(0, separator), test: pair.slice(separator + 1) };
    });
}

function replayOptions(args) {
    const limit = Number(args[0]);
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('--replay requires a positive integer');
    }
    const options = { limit, narrowPrefixes: [], mustSelect: [] };
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value || (flag !== '--narrow' && flag !== '--must-select')) {
            throw new Error(`invalid replay option: ${flag || ''}`.trim());
        }
        if (flag === '--narrow') options.narrowPrefixes.push(...parseList(value));
        else options.mustSelect.push(...parseMustSelect(value));
    }
    return options;
}

function runReplay(args) {
    try {
        const options = replayOptions(args);
        const result = replayPlans(options.limit, options.narrowPrefixes);
        process.stdout.write('plan commits consensus-1 changed-tests test-only no-tests\n');
        printReplayRow('current', result.commits.length, result.current);
        if (options.narrowPrefixes.length) {
            printReplayRow('narrowed', result.commits.length, result.narrowed);
        }
        let failed = false;
        for (const pair of options.mustSelect) {
            const plan = selectFastTests([pair.source], result.dependencies, {
                narrowPrefixes: result.narrowPrefixes,
            });
            const selected = plan.tests.some((test) => test.file === pair.test);
            process.stdout.write(`must-select ${selected ? 'PASS' : 'FAIL'} ${pair.source}:${pair.test}\n`);
            if (!selected) failed = true;
        }
        return failed ? 1 : 0;
    } catch (error) {
        process.stderr.write(`replay-error ${error.message}\n`);
        return 2;
    }
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
    if (mode === '--replay') return runReplay(process.argv.slice(3));
    if (mode !== '--plan' && mode !== '--run') {
        process.stderr.write('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
            '[--narrow prefix,...] [--must-select file:testfile,...]\n');
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

module.exports = { resolveBase, selectFastTests, listTests, findRequirers, replayPlans };

if (require.main === module) process.exitCode = main();
