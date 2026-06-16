// @ts-nocheck
// 
'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Standalone custom mutation runner for XChain VM.
//
// Applies each VM-specific mutation (from mutators.js) to source files,
// runs the test suite against the mutated code, and records kill/survive.
// Outputs results as JSON compatible with the mutation-report.js reporter.
//
// Usage:
//   node stryker-xchain-vm-mutator/index.js [--mutate src/gas.js,src/sandbox.js] [--spec test/*.test.js] [--timeout 30000] [--concurrency 2]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateAllMutants, ALL_OPERATORS } = require('./mutators.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_MUTATE = 'src/*.js';
const DEFAULT_SPEC = 'test/*.test.js';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_CONCURRENCY = 1;
const OUTPUT_FILE = path.join(ROOT, 'reports', 'mutation', 'custom-mutant-results.json');

// ─── CLI arg parsing ────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        mutate: DEFAULT_MUTATE,
        spec: DEFAULT_SPEC,
        timeout: DEFAULT_TIMEOUT,
        concurrency: DEFAULT_CONCURRENCY,
        dryRun: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--mutate':    opts.mutate = args[++i]; break;
            case '--spec':      opts.spec = args[++i]; break;
            case '--timeout':   opts.timeout = parseInt(args[++i], 10); break;
            case '--concurrency': opts.concurrency = parseInt(args[++i], 10); break;
            case '--dryRun':    opts.dryRun = true; break;
        }
    }

    return opts;
}

// ─── File resolution ────────────────────────────────────────────────────────

function resolveGlob(pattern) {
    // Simple glob resolution using the shell
    const result = spawnSync('sh', ['-c', `ls ${pattern} 2>/dev/null`], { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    return result.stdout.trim().split('\n').map(f => f.trim()).filter(Boolean);
}

// ─── Test runner ────────────────────────────────────────────────────────────

function runTests(spec, timeout) {
    const mochaBin = path.join(ROOT, 'node_modules', '.bin', 'mocha');
    const result = spawnSync(mochaBin, [
        '--timeout', String(timeout),
        spec
    ], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: timeout * 2.5,  // wall-clock timeout with buffer
        env: { ...process.env, NODE_ENV: 'test' }
    });

    return {
        passed: result.status === 0,
        timedOut: result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT',
        output: (result.stdout || '').slice(-500) + (result.stderr || '').slice(-500)
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
    const opts = parseArgs();
    const files = resolveGlob(opts.mutate);

    if (files.length === 0) {
        console.error('No files matched pattern: ' + opts.mutate);
        process.exit(1);
    }

    console.log('XChain VM Custom Mutation Runner');
    console.log('================================');
    console.log('Files to mutate: ' + files.join(', '));
    console.log('Test spec:       ' + opts.spec);
    console.log('Timeout:         ' + opts.timeout + 'ms');
    console.log('');

    // Generate all mutants across all target files
    const allMutants = [];
    for (const file of files) {
        const absPath = path.join(ROOT, file);
        const source = fs.readFileSync(absPath, 'utf8');
        const mutants = generateAllMutants(source, file);
        for (const m of mutants) {
            allMutants.push({ ...m, file: file, absPath: absPath, originalSource: source });
        }
    }

    console.log('Generated ' + allMutants.length + ' custom mutants across ' + files.length + ' file(s)');
    console.log('');

    // Per-operator summary
    const opCounts = {};
    for (const m of allMutants) {
        opCounts[m.mutatorName] = (opCounts[m.mutatorName] || 0) + 1;
    }
    for (const [op, count] of Object.entries(opCounts)) {
        console.log('  ' + op + ': ' + count + ' mutant(s)');
    }
    console.log('');

    if (opts.dryRun) {
        console.log('[DRY RUN] Would test ' + allMutants.length + ' mutants. Exiting.');

        // Still output the mutant list for inspection
        for (let i = 0; i < allMutants.length; i++) {
            const m = allMutants[i];
            console.log('  #' + (i + 1) + ' ' + m.file + ':' + m.location.start.line +
                        ' [' + m.mutatorName + '] ' +
                        JSON.stringify(m.original).slice(0, 60) + ' -> ' +
                        JSON.stringify(m.replacement).slice(0, 60));
        }
        process.exit(0);
    }

    // First, verify the unmutated test suite passes
    console.log('Running baseline test suite...');
    const baseline = runTests(opts.spec, opts.timeout);
    if (!baseline.passed) {
        console.error('ERROR: Baseline tests failed. Fix tests before running mutation testing.');
        console.error(baseline.output.slice(-300));
        process.exit(1);
    }
    console.log('Baseline: PASSED');
    console.log('');

    // Run each mutant
    const results = [];
    let killed = 0;
    let survived = 0;
    let timedOut = 0;
    let errored = 0;

    for (let i = 0; i < allMutants.length; i++) {
        const m = allMutants[i];
        const label = '[' + (i + 1) + '/' + allMutants.length + '] ' +
                      m.file + ':' + m.location.start.line + ' ' + m.mutatorName;

        // Apply mutation
        try {
            fs.writeFileSync(m.absPath, m.mutatedSource, 'utf8');
        } catch (e) {
            console.log(label + ' ... ERROR (write failed)');
            errored++;
            results.push({ ...formatResult(m, i), status: 'CompileError', statusReason: e.message });
            continue;
        }

        // Run tests
        const testResult = runTests(opts.spec, opts.timeout);

        // Restore original
        fs.writeFileSync(m.absPath, m.originalSource, 'utf8');

        // Classify result
        let status;
        if (testResult.timedOut) {
            status = 'Timeout';
            timedOut++;
        } else if (!testResult.passed) {
            status = 'Killed';
            killed++;
        } else {
            status = 'Survived';
            survived++;
        }

        const symbol = status === 'Killed' ? 'x' :
                       status === 'Timeout' ? 'T' :
                       status === 'Survived' ? '.' : '?';

        process.stdout.write(symbol);
        if ((i + 1) % 50 === 0 || i === allMutants.length - 1) {
            process.stdout.write(' ' + (i + 1) + '/' + allMutants.length + '\n');
        }

        results.push({ ...formatResult(m, i), status: status });
    }

    console.log('');
    console.log('');

    // Summary
    const total = killed + survived + timedOut + errored;
    const score = total > 0 ? ((killed + timedOut) / total * 100) : 0;

    console.log('Custom Mutation Results');
    console.log('======================');
    console.log('Total:    ' + total);
    console.log('Killed:   ' + killed);
    console.log('Survived: ' + survived);
    console.log('Timeout:  ' + timedOut);
    console.log('Errored:  ' + errored);
    console.log('Score:    ' + score.toFixed(1) + '%');
    console.log('');

    // Print survived mutants
    const survivedMutants = results.filter(r => r.status === 'Survived');
    if (survivedMutants.length > 0) {
        console.log('Survived Mutations (test gaps):');
        for (const s of survivedMutants) {
            console.log('  ' + s.fileName + ':' + s.location.start.line +
                        ' [' + s.mutatorName + '] ' + s.replacement);
        }
        console.log('');
    }

    // Write JSON output
    const outDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const output = {
        schemaVersion: '1',
        projectRoot: ROOT,
        generatedAt: new Date().toISOString(),
        summary: { total, killed, survived, timedOut, errored, score },
        files: {}
    };

    // Group results by file
    for (const r of results) {
        if (!output.files[r.fileName]) {
            output.files[r.fileName] = { mutants: [] };
        }
        output.files[r.fileName].mutants.push(r);
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log('Results written to: ' + OUTPUT_FILE);
}

function formatResult(m, idx) {
    return {
        id: 'custom-' + idx,
        mutatorName: m.mutatorName,
        fileName: m.file,
        replacement: m.replacement,
        original: m.original,
        location: m.location
    };
}

main();
