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
 * Every cross-repo guard decides sibling presence through the shared helper.
 *
 * A bare fs.existsSync on a sibling path answers true for a lane worktree
 * whose sibling entry is a symlink into a live main checkout, so the guard
 * reads uncommitted bytes and passes against state no commit pins. The
 * helper in test/helpers/sibling_checkout.js refuses that layout. This census
 * fails when a test file names a sibling repo path and probes the filesystem
 * for it without loading that helper.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_ROOT = path.join(REPO_ROOT, 'test');
const HELPER    = path.join(TEST_ROOT, 'helpers', 'sibling_checkout.js');

// A quoted or slash-delimited sibling repo name, the way guards spell a sibling path.
const SIBLING_LITERAL = /['"`/]xchain-(?:indexer|sdk|documentation|contracts|decoder|encoder|explorer|hub|sync|wallet|e2e-test|utxo-tracker)['"`/]/;
const PRESENCE_PROBE  = /\bexistsSync\s*\(/;
const HELPER_LOAD     = /require\(\s*['"][./]*helpers\/sibling_checkout(?:\.js)?['"]\s*\)/;

// Drop block comments and whole-line comments so prose that names a sibling is not a reader.
function codeOnly(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Classify one source: does it read a sibling, and does it route presence through the helper?
function classify(source) {
    const code = codeOnly(source);
    const readsSibling = SIBLING_LITERAL.test(code) && PRESENCE_PROBE.test(code);
    return { readsSibling, usesHelper: HELPER_LOAD.test(code) };
}

// List every .js file under test/, skipping the helper itself and installed packages.
function testFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) testFiles(abs, out);
        else if (entry.name.endsWith('.js') && abs !== HELPER && abs !== __filename) out.push(abs);
    }
    return out;
}

describe('cross-repo guards route sibling presence through sibling_checkout', function () {

    it('flags a bare existsSync on a sibling path and passes the helper form', function () {
        const bare = "const p = path.join(ROOT, 'xchain-indexer', 'src', 'a.js');\nif (!fs.existsSync(p)) this.skip();\n";
        const routed = "const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js');\n" + bare;
        const commented = "// reads '../xchain-indexer/src/a.js'\nif (fs.existsSync(LOCAL)) run();\n";
        assert.deepStrictEqual(classify(bare), { readsSibling: true, usesHelper: false });
        assert.deepStrictEqual(classify(routed), { readsSibling: true, usesHelper: true });
        assert.strictEqual(classify(commented).readsSibling, false, 'a sibling named only in a comment is not a reader');
    });

    it('every test file that probes a sibling path loads the helper', function () {
        const files = testFiles(TEST_ROOT);
        assert.ok(files.length > 100, 'the census walked only ' + files.length + ' files under ' + TEST_ROOT);

        const readers = files.filter((f) => classify(fs.readFileSync(f, 'utf8')).readsSibling);
        // Keep the census from passing by finding nothing to grade.
        assert.ok(readers.length >= 10, 'expected the known cross-repo guards, found ' + readers.length + ' sibling readers');

        const bare = readers
            .filter((f) => !classify(fs.readFileSync(f, 'utf8')).usesHelper)
            .map((f) => path.relative(REPO_ROOT, f))
            .sort();
        assert.deepStrictEqual(bare, [],
            'these guards probe a sibling with bare existsSync, which a lane symlink into a live main ' +
            'checkout satisfies; decide presence with siblingCheckout() and skipOrFail() from test/helpers/sibling_checkout.js:\n  ' +
            bare.join('\n  '));
    });
});
