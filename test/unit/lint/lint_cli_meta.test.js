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
 * The lint CLI enforces the contract-identity (meta) rule the deploy gate
 * blocks on, and never passes a contract the toolkit gate refuses.
 *
 * Requires isolated-vm (validateSyntax step 1) → skips when unavailable.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');
const { runGate } = require('../../../src/toolkit/gate.js');

const LINT_BIN = path.join(__dirname, '../../../bin/lint.js');

let lintFile = null;
try {
    ({ lintFile } = require('../../../bin/lint.js'));
} catch (e) {
    console.log('Skipping lint-cli meta tests (isolated-vm not available):', e.message);
}

const NO_META    = 'module.exports = { init: function () { return 1; } };';
const GOOD_META  = "module.exports = { meta: { name: 'Demo', description: 'A demo contract' }, init: function () { return 1; } };";
const EMPTY_NAME = "module.exports = { meta: { name: '', description: 'x' }, init: function () { return 1; } };";
const NO_EXPORTS = 'function init(){ return 1; } function add(a,b){ return a + b; }';
const BANNED     = "module.exports = { meta: { name: 'Demo', description: 'd' }, f: function () { return Math.sqrt(4); } };";

function runCli(args) {
    try {
        const stdout = execFileSync(process.execPath, [LINT_BIN, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '' };
    } catch (e) {
        return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const rulesOf = (list) => list.map((f) => f.rule);

(lintFile ? describe : describe.skip)('lint CLI (bin/lint.js) contract-identity rule', function () {
    this.timeout(60000);

    let dir;
    const write = (name, code) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, code);
        return p;
    };
    before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-lint-meta-')); });
    after(function () { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

    it('fails a contract whose literal export has no meta', function () {
        const r = lintFile(write('no-meta.js', NO_META));
        assert.strictEqual(r.ok, false);
        const meta = r.errors.find((e) => e.rule === 'contract-meta');
        assert.ok(meta, JSON.stringify(r.errors));
        assert.ok(meta.message.startsWith('invalid: CONTRACT_MANIFEST (meta required)'), meta.message);
    });

    it('fails a contract with an invalid literal meta name', function () {
        const r = lintFile(write('empty-name.js', EMPTY_NAME));
        assert.strictEqual(r.ok, false);
        assert.ok(r.errors.some((e) => e.rule === 'contract-meta' && /meta\.name|name/.test(e.message)),
            JSON.stringify(r.errors));
    });

    it('passes a contract with a valid literal meta', function () {
        const r = lintFile(write('good-meta.js', GOOD_META));
        assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
        assert.ok(!rulesOf(r.errors).includes('contract-meta'));
    });

    it('only warns when the meta cannot be read statically', function () {
        const r = lintFile(write('no-exports.js', NO_EXPORTS));
        assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
        assert.ok(!rulesOf(r.errors).some((rule) => rule.startsWith('contract-meta')));
        assert.ok(rulesOf(r.warnings).includes('contract-meta-undecidable'), JSON.stringify(r.warnings));
    });

    it('exits 1 naming contract-meta for a meta-less contract', function () {
        const r = runCli([write('cli-no-meta.js', NO_META)]);
        assert.strictEqual(r.status, 1, r.stdout);
        assert.ok(r.stderr.indexOf('contract-meta') !== -1, r.stderr);
    });

    it('fails every fixture the toolkit gate refuses', function () {
        let refused = 0;
        for (const [name, code] of [['a', NO_META], ['b', EMPTY_NAME], ['c', BANNED],
            ['d', GOOD_META], ['e', NO_EXPORTS], ['f', 'var x = 3.14; function f(){ return x; }']]) {
            if (runGate(code).ok) continue;
            refused++;
            const r = lintFile(write('parity-' + name + '.js', code));
            assert.strictEqual(r.ok, false, 'the gate refuses fixture ' + name + ' but the CLI passes it: ' +
                JSON.stringify(runGate(code).errors));
        }
        // Guard the loop itself: three fixtures are gate-refused, so a vacuous pass reads as a miscount.
        assert.strictEqual(refused, 3);
    });
});
