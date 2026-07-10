#!/usr/bin/env node
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
 * XChain VM: Contract Lint CLI (authoritative; Node 22)
 *
 * Runs the FULL deploy-time validation: validateSyntax (including the
 * isolated-vm V8 syntax compile) + checkFloatWarnings, over one or more
 * contract source files. This is exact deploy parity: a clean result here
 * means the DEPLOY will pass the indexer's syntax gate.
 *
 *   node bin/lint.js <file...>     lint each file (shell globs expand first)
 *     --json                       machine-readable JSON report on stdout
 *
 *   exit 0  = all clean (warnings, if any, go to stderr)
 *   exit 1  = at least one file has a blocking error
 *   exit 2  = usage / no readable input files
 ********************************************************************/
// @ts-nocheck

const fs   = require('fs');
const path = require('path');

const { validateSyntax } = require('../src/syntax.js');
const { lintSource, CONSENSUS_RULES } = require('../src/lint-core.js');
// The 64 KiB deploy cap (65536). The indexer rejects oversized code BEFORE its
// syntax gate (actions/deploy.js → CODE_ENCODING) and the VM enforces the same
// cap at execute time, so the deploy-parity promise above requires this CLI to
// enforce it too; a 64KiB-to-parse-ceiling contract must not lint ✓ clean.
const { MAX_CODE_SIZE } = require('../src/index.js');

function usage(msg) {
    if (msg) process.stderr.write('xchain-lint: ' + msg + '\n');
    process.stderr.write('usage: xchain-lint [--json] <file...>\n');
    process.exit(2);
}

// Expand any args containing glob metacharacters via fs.globSync when present
// (Node 22+); otherwise treat the arg as a literal path. Shells normally expand
// globs before we ever see them, so this is just a convenience fallback.
function expandArg(arg) {
    if (/[*?[\]]/.test(arg) && typeof fs.globSync === 'function') {
        try { return fs.globSync(arg); } catch (e) { return []; }
    }
    return [arg];
}

function lintFile(file) {
    let code;
    try {
        code = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { file, ok: false, readError: e.message, errors: [], warnings: [] };
    }

    // Authoritative deploy verdict (includes the V8 step-1 compile).
    const verdict = validateSyntax(code);
    // Full structured view: every acorn-coverable rule + Move-2 advisories.
    const lint = lintSource(code);

    const errors = lint.errors.slice();
    // A V8-only step-1 failure (acorn parsed, but V8 rejected) won't appear in
    // lint-core's errors. Surface validateSyntax's message in that case.
    if (!verdict.valid && !errors.some((e) => CONSENSUS_RULES.has(e.rule)))
        errors.unshift({ rule: 'syntax', message: verdict.error, line: null, severity: 'error' });
    // Deploy-gate parity: the indexer rejects code over MAX_CODE_SIZE before it
    // ever reaches the syntax gate, so surface the size failure FIRST (CLI-side
    // rule; the on-chain verdict is enforced by the indexer/VM, not lint-core).
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_SIZE)
        errors.unshift({ rule: 'code-size', message: 'code size exceeds limit (' + MAX_CODE_SIZE + ' bytes)', line: null, severity: 'error' });

    // The CLI is the author-facing gate: any error-severity finding fails the
    // file (exit 1), including the non-deploy-blocking crossCallable-not-array.
    return { file, ok: errors.length === 0, errors, warnings: lint.warnings };
}

function main() {
    const argv = process.argv.slice(2);
    let json = false;
    const inputs = [];
    for (const a of argv) {
        if (a === '--json') json = true;
        else if (a === '-h' || a === '--help') usage();
        else if (a.startsWith('-')) usage('unknown flag: ' + a);
        else inputs.push(a);
    }
    if (inputs.length === 0) usage('no input files');

    const files = [];
    for (const arg of inputs) for (const f of expandArg(arg)) files.push(f);
    if (files.length === 0) usage('no files matched');

    const results = files.map(lintFile);

    if (json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    } else {
        for (const r of results) {
            const rel = path.relative(process.cwd(), r.file) || r.file;
            if (r.readError) {
                process.stderr.write('✗ ' + rel + ': cannot read (' + r.readError + ')\n');
                continue;
            }
            if (r.ok && r.warnings.length === 0) {
                process.stdout.write('✓ ' + rel + '\n');
            } else if (r.ok) {
                process.stdout.write('✓ ' + rel + ' (' + r.warnings.length + ' warning' +
                    (r.warnings.length === 1 ? '' : 's') + ')\n');
            } else {
                process.stdout.write('✗ ' + rel + '\n');
            }
            for (const e of r.errors)
                process.stderr.write('    error [' + e.rule + ']: ' + e.message + '\n');
            for (const w of r.warnings)
                process.stderr.write('    warning [' + w.rule + ']: ' + w.message + '\n');
        }
    }

    const anyError = results.some((r) => r.readError || !r.ok);
    process.exit(anyError ? 1 : 0);
}

// CLI when executed directly; importable for tests (test/unit/lint-cli.test.js
// drives lintFile without spawning a process). main() still owns argv/exit.
if (require.main === module) main();
else module.exports = { lintFile, expandArg };
