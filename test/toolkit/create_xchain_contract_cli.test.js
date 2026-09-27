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
 * Toolkit: create-xchain-contract CLI. Spawns the bin as a subprocess
 * because it runs at module load and exits the process directly.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '../../bin/create-xchain-contract.js');

function run(args) {
    return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

describe('create-xchain-contract CLI', () => {
    let tmp;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxc-cli-')); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('exits 2 with a Usage line when no name is given', () => {
        const r = run([]);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /Usage:/);
    });

    it('scaffolds a project and reports it', () => {
        const dir = path.join(tmp, 'proj');
        const r = run(['demo', '--dir', dir]);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('Created demo at ' + dir), r.stdout);
        assert.ok(fs.existsSync(path.join(dir, 'contracts', 'demo.js')));
        assert.ok(fs.existsSync(path.join(dir, 'README.md')));
        assert.ok(fs.existsSync(path.join(dir, 'package.json')));
        assert.ok(fs.existsSync(path.join(dir, 'test', 'demo.test.js')));
    });

    it('refuses to overwrite without --force and succeeds with it', () => {
        const dir = path.join(tmp, 'proj');
        assert.strictEqual(run(['demo', '--dir', dir]).status, 0);
        const again = run(['demo', '--dir', dir]);
        assert.strictEqual(again.status, 1);
        assert.match(again.stderr, /refusing to overwrite/);
        const forced = run(['demo', '--dir', dir, '--force']);
        assert.strictEqual(forced.status, 0, forced.stderr);
    });

    it('--ts emits a TypeScript contract and labels the output', () => {
        const dir = path.join(tmp, 'proj');
        const r = run(['demo', '--ts', '--dir', dir]);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('(TypeScript)'), r.stdout);
        assert.ok(fs.existsSync(path.join(dir, 'contracts', 'demo.ts')));
        assert.ok(!fs.existsSync(path.join(dir, 'contracts', 'demo.js')));
    });
});
