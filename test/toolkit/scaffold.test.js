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
const { runGate } = require('../../src/toolkit/gate.js');
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
