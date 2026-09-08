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
 * Toolkit: project scaffolder. Static (no isolated-vm). Also asserts the
 * generated contract is determinism-gate-clean, so `xchain-foundry new`
 * always emits a deployable starting point.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildScaffold, writeScaffold } = require('../../src/toolkit/scaffold.js');
const { runGate, getExportedMeta } = require('../../src/toolkit/gate.js');
const { toContractJs } = require('../../src/toolkit/transpile.js');

describe('Toolkit scaffold', function() {

    it('builds a JS project with contract, test, package.json, README', function() {
        const { files, contractFile } = buildScaffold({ name: 'my-counter' });
        assert.strictEqual(contractFile, 'my-counter.js');
        assert(files['contracts/my-counter.js']);
        assert(files['test/my-counter.test.js']);
        assert(files['package.json']);
        assert(files['README.md']);
        // package.json must be valid JSON with the bin-driven scripts.
        const pkg = JSON.parse(files['package.json']);
        assert.strictEqual(pkg.name, 'my-counter');
        assert(pkg.scripts.test.includes('mocha'));
    });

    it('emits a determinism-gate-clean JS contract', function() {
        const { files, contractFile } = buildScaffold({ name: 'clean-js' });
        const gate = runGate(files['contracts/' + contractFile]);
        assert.strictEqual(gate.ok, true, 'scaffolded contract must pass the gate: ' +
            JSON.stringify(gate.errors));
    });

    it('emits a deployable identity: meta first, named for the project, gate-clean', function() {
        // A scaffold without `meta` is undeployable under CONTRACT_META_REQUIRED, so
        // the starting point the toolkit hands an author has to carry one.
        const { files, contractFile } = buildScaffold({ name: 'ident-js' });
        const src = files['contracts/' + contractFile];
        const meta = getExportedMeta(src);
        assert.strictEqual(meta.status, 'present', 'the scaffold must export a literal meta');
        assert.strictEqual(meta.name, 'ident-js', 'meta.name must be the project name');
        assert.strictEqual(meta.version, '1.0.0');
        assert(meta.description && meta.description.length > 0, 'a placeholder description must be emitted');
        assert(/TODO/.test(meta.description), 'the description must read as an author TODO, not as final copy');
        // First key: the author sees identity before anything else, and it matches
        // the shape the templates and the docs teach.
        assert.match(src, /module\.exports = \{\s*(?:\/\/[^\n]*\n\s*)*meta: \{/,
            'meta must be the FIRST key of the export object');
        assert.strictEqual(runGate(src).errors.filter(e => e.rule === 'contract-meta').length, 0);
    });

    it('emits a TS scaffold whose stripped identity is the same', function() {
        const { files, contractFile } = buildScaffold({ name: 'ident-ts', typescript: true });
        const js = toContractJs(files['contracts/' + contractFile], contractFile);
        const meta = getExportedMeta(js);
        assert.strictEqual(meta.status, 'present');
        assert.strictEqual(meta.name, 'ident-ts');
        assert.strictEqual(meta.version, '1.0.0');
    });

    it('refuses a project name past the 64-byte meta.name cap', function() {
        // The name is emitted as meta.name, so an over-long one would scaffold a
        // project that cannot deploy; fail at scaffold time instead.
        assert.throws(() => buildScaffold({ name: 'a'.repeat(65) }), /64 bytes/);
        assert.doesNotThrow(() => buildScaffold({ name: 'a'.repeat(64) }));
    });

    it('emits a TS contract that strips to a gate-clean JS contract', function() {
        const { files, contractFile } = buildScaffold({ name: 'clean-ts', typescript: true });
        assert.strictEqual(contractFile, 'clean-ts.ts');
        const src = files['contracts/' + contractFile];
        assert(/interface XChain/.test(src), 'TS scaffold should carry type annotations');
        const js = toContractJs(src, contractFile);
        assert(!/interface XChain/.test(js), 'types should strip away');
        const gate = runGate(js);
        assert.strictEqual(gate.ok, true, 'stripped TS contract must pass the gate: ' +
            JSON.stringify(gate.errors));
    });

    it('offers the subprocess execution mode in the generated test harness', function() {
        // The generated beforeEach runs the simulator's in-process default, which
        // cannot reproduce the chain's host-termination result: a contract that
        // aborts the JS engine kills the test run instead of returning
        // out_of_resource. The commented option is the author's route to the mode
        // the indexer runs, so it must survive an edit to the template. It stays
        // COMMENTED because the un-awaited isolate probe above it would leak a
        // worker child in subprocess mode.
        const { files } = buildScaffold({ name: 'exec-mode' });
        const testJs = files['test/exec-mode.test.js'];
        assert.match(testJs, /\/\/ execution: 'subprocess'/,
            'the scaffolded test harness no longer names the subprocess mode');
        assert.match(testJs, /out_of_resource/,
            'the scaffolded comment must say what the mode buys, not merely name it');
        assert.doesNotMatch(testJs, /^\s*execution: 'subprocess'/m,
            'the subprocess option must stay commented out in the generated harness');
    });

    it('rejects an unsafe project name', function() {
        assert.throws(() => buildScaffold({ name: '../evil' }), /invalid project name/);
    });

    it('writes to disk and refuses to clobber without force', function() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-scaffold-'));
        try {
            const res = writeScaffold(dir, { name: 'ondisk' });
            assert(res.written.length >= 4);
            assert(fs.existsSync(path.join(dir, 'contracts', 'ondisk.js')));
            // second write without force must throw
            assert.throws(() => writeScaffold(dir, { name: 'ondisk' }), /refusing to overwrite/);
            // with force it succeeds
            const res2 = writeScaffold(dir, { name: 'ondisk', force: true });
            assert(res2.written.length >= 4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
