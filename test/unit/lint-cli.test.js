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
 * Deploy-parity lint CLI (bin/lint.js) coverage.
 *
 * The CLI is the author-facing deploy-parity gate ("a clean result here
 * means the DEPLOY will pass the indexer's syntax gate"). Its lintFile()
 * merges the authoritative validateSyntax verdict with the shared
 * lintSource rules; the CONSENSUS_RULES reconciliation branch is the only
 * place a V8-only step-1 failure (acorn parses, V8 rejects) is surfaced
 * as a blocking error, and the code-size rule mirrors the indexer's
 * 64 KiB CODE_ENCODING gate that runs BEFORE its syntax gate. None of
 * this was covered anywhere (the parity suites import src/ directly and
 * never load the CLI), so a regression here mis-reported deploy validity
 * with no CI failure.
 *
 * Requires isolated-vm (validateSyntax step 1) → skips when unavailable.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const LINT_BIN = path.join(__dirname, '..', '..', 'bin', 'lint.js');

// bin/lint.js exports { lintFile, expandArg } when required as a module
// (require.main guard); it pulls in isolated-vm via src/syntax.js, so skip
// the suite on hosts without the native build (same pattern as sandbox tests).
let lintFile = null;
let MAX_CODE_SIZE = 65536;
try {
    ({ lintFile } = require('../../bin/lint.js'));
    ({ MAX_CODE_SIZE } = require('../../src/index.js'));
} catch (e) {
    console.log('Skipping lint-cli tests (isolated-vm not available):', e.message);
}

const GOOD_CODE  = 'function init(){ return 1; } function add(a,b){ return a + b; }';
const BAD_CODE   = 'function f(){ return Math.sqrt(4); }';           // banned-math (CONSENSUS_RULES)
const FLOAT_CODE = 'var x = 3.14; function f(){ return x; }';        // non-blocking warning
// V8-only step-1 failure: acorn has no parameter-count limit, V8 rejects
// >65534 params ("Too many parameters") at compile. lintSource returns NO
// consensus-rule error for it, so ONLY the reconciliation branch can surface
// the failure. (The fixture is also >64 KiB, so the code-size rule fires too;
// both must be present.)
const V8_ONLY_CODE = 'function f(' +
    Array.from({ length: 66000 }, (_, i) => 'p' + i).join(',') +
    '){ return 1; }';

function padTo(code, bytes) {
    // Pad with a trailing line comment to an exact byte length.
    const pad = bytes - Buffer.byteLength(code, 'utf8') - 4;
    return code + '\n// ' + 'x'.repeat(pad);
}

(lintFile ? describe : describe.skip)('lint CLI (bin/lint.js) deploy parity', function () {
    this.timeout(60000);

    let dir;
    const write = (name, code) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, code);
        return p;
    };
    before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-lint-cli-')); });
    after(function () { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

    describe('lintFile()', function () {
        it('good contract: ok=true, no errors', function () {
            const r = lintFile(write('good.js', GOOD_CODE));
            assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
            assert.strictEqual(r.errors.length, 0);
            assert.strictEqual(r.readError, undefined);
        });

        it('consensus-rule failure surfaces the shared rule and does NOT double-report a syntax error', function () {
            const r = lintFile(write('bad.js', BAD_CODE));
            assert.strictEqual(r.ok, false);
            assert.ok(r.errors.some((e) => e.rule === 'banned-math'),
                'banned-math must be reported: ' + JSON.stringify(r.errors));
            // The :69 short-circuit: verdict.valid is false here, but a
            // CONSENSUS_RULES error already covers it, so no synthetic
            // {rule:'syntax'} entry may be unshifted on top.
            assert.ok(!r.errors.some((e) => e.rule === 'syntax'),
                'must not double-report when a consensus rule already fired: ' + JSON.stringify(r.errors));
        });

        it('float literal: non-blocking warning, ok=true', function () {
            const r = lintFile(write('float.js', FLOAT_CODE));
            assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
            assert.ok(r.warnings.length >= 1, 'float must warn');
        });

        it('V8-only step-1 failure is surfaced as a blocking syntax error (reconciliation branch)', function () {
            const r = lintFile(write('v8only.js', V8_ONLY_CODE));
            assert.strictEqual(r.ok, false);
            const syn = r.errors.find((e) => e.rule === 'syntax');
            assert.ok(syn, 'the V8-only failure must surface via the reconciliation branch: '
                + JSON.stringify(r.errors.map((e) => e.rule)));
            assert.match(syn.message, /^syntax error: /, syn.message);
            assert.strictEqual(syn.severity, 'error');
        });

        it('code over MAX_CODE_SIZE fails with the code-size rule FIRST (deploy-gate order)', function () {
            const r = lintFile(write('big.js', padTo(GOOD_CODE, MAX_CODE_SIZE + 1)));
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.errors[0].rule, 'code-size',
                'size must report ahead of everything, like the deploy gate: ' + JSON.stringify(r.errors));
            assert.ok(r.errors[0].message.indexOf(String(MAX_CODE_SIZE)) !== -1,
                'message must name the limit: ' + r.errors[0].message);
        });

        it('code exactly AT MAX_CODE_SIZE lints clean (boundary parity with the deploy gate)', function () {
            const r = lintFile(write('edge.js', padTo(GOOD_CODE, MAX_CODE_SIZE)));
            assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
        });

        it('unreadable file: ok=false with readError', function () {
            const r = lintFile(path.join(dir, 'nope-does-not-exist.js'));
            assert.strictEqual(r.ok, false);
            assert.ok(r.readError, 'readError must be set');
            assert.strictEqual(r.errors.length, 0);
        });
    });

    describe('CLI process level (exit codes + output)', function () {
        const runCli = (args) => {
            try {
                const stdout = execFileSync(process.execPath, [LINT_BIN, ...args],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
                return { status: 0, stdout };
            } catch (e) {
                return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
            }
        };

        it('clean file → exit 0 and ✓', function () {
            const p = write('cli-good.js', GOOD_CODE);
            const r = runCli([p]);
            assert.strictEqual(r.status, 0, r.stderr);
            assert.ok(r.stdout.indexOf('✓') !== -1, r.stdout);
        });

        it('blocking error → exit 1 and the rule on stderr', function () {
            const p = write('cli-bad.js', BAD_CODE);
            const r = runCli([p]);
            assert.strictEqual(r.status, 1);
            assert.ok((r.stderr || '').indexOf('banned-math') !== -1, r.stderr);
        });

        it('oversized file → exit 1 with code-size', function () {
            const p = write('cli-big.js', padTo(GOOD_CODE, MAX_CODE_SIZE + 1));
            const r = runCli([p]);
            assert.strictEqual(r.status, 1);
            assert.ok((r.stderr || '').indexOf('code-size') !== -1, r.stderr);
        });

        it('no input files → usage exit 2', function () {
            const r = runCli([]);
            assert.strictEqual(r.status, 2);
        });

        // The gate's contract is 'exit 0 = all clean'. A quoted glob that matches
        // nothing (a renamed directory in a CI script) used to expand to [] and
        // disappear, so a run with one surviving argument exited 0 having never
        // linted the intended files. Every zero-match argument now fails closed on
        // the exit-2 channel the header reserves for 'no readable input files'.
        it('a glob matching nothing → exit 2 naming the pattern, even when another argument matched', function () {
            const p = write('cli-glob-good.js', GOOD_CODE);
            const r = runCli([p, path.join(dir, 'no-such-dir', '*.js')]);
            assert.strictEqual(r.status, 2, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
            assert.ok((r.stderr || '').indexOf('no files matched: ') !== -1, r.stderr);
            assert.ok((r.stderr || '').indexOf('no-such-dir') !== -1,
                'the stale pattern must be named: ' + r.stderr);
            // The surviving file is never reported: the run aborts before linting.
            assert.strictEqual(r.stdout.indexOf('✓'), -1, r.stdout);
        });

        it('every zero-match argument is named in one run, not just the first', function () {
            const r = runCli([path.join(dir, 'gone-a', '*.js'), path.join(dir, 'gone-b', '*.js')]);
            assert.strictEqual(r.status, 2, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
            assert.ok((r.stderr || '').indexOf('gone-a') !== -1, r.stderr);
            assert.ok((r.stderr || '').indexOf('gone-b') !== -1, r.stderr);
        });

        it('a literal missing path still fails through the read-error path (exit 1), not the glob channel', function () {
            const r = runCli([path.join(dir, 'definitely-absent.js')]);
            assert.strictEqual(r.status, 1, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
            assert.ok((r.stderr || '').indexOf('cannot read') !== -1, r.stderr);
        });

        it('--json emits a machine-readable report matching lintFile()', function () {
            const p = write('cli-json.js', BAD_CODE);
            const r = runCli(['--json', p]);
            assert.strictEqual(r.status, 1);
            const report = JSON.parse(r.stdout);
            assert.strictEqual(report.length, 1);
            assert.strictEqual(report[0].ok, false);
            assert.ok(report[0].errors.some((e) => e.rule === 'banned-math'));
        });
    });
});
