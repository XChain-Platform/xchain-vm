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
 * [BUG] test:regression:bugfix matched no files at all
 *
 * The tier shipped pointing at test/regression/bugs/, a directory that
 * was never created, so every invocation ended in mocha's "No test
 * files found" without running a single assertion. A named tier that
 * matches nothing reads, in a scripts table or a release readout, as a
 * tier that passed.
 *
 * This test re-derives the tier's own globs from package.json and
 * fails if any of them resolves to zero files, so emptying the
 * directory again turns the tier red instead of vacuous.
 *
 * Run: npm run test:regression:bugfix
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_NAME  = 'test:regression:bugfix';

// Every file under dir, as paths relative to the package root with
// forward slashes, which is the shape the package scripts' globs use.
function listFiles(dir, rootRelative) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;             // a glob's base directory may not exist
    }
    for (const entry of entries) {
        const rel = rootRelative ? rootRelative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

// Minimal translation of the glob syntax the scripts actually use:
// ** spans directory separators, * does not, everything else literal.
function globToRegExp(glob) {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                // `**/` may also stand for zero directories
                if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2; }
                else { source += '.*'; i += 1; }
            } else {
                source += '[^/]*';
            }
        } else {
            source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + source + '$');
}

// The base directory of a glob: everything before its first wildcard.
function globBase(glob) {
    const firstStar = glob.indexOf('*');
    const head = firstStar === -1 ? glob : glob.slice(0, firstStar);
    const cut  = head.lastIndexOf('/');
    return cut === -1 ? '' : head.slice(0, cut);
}

describe('[BUG] regression:bugfix tier resolves to real test files', function() {

    let globs;

    before(function() {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
        const script = pkg.scripts && pkg.scripts[SCRIPT_NAME];
        assert.strictEqual(typeof script, 'string',
            `package.json must declare a ${SCRIPT_NAME} script (this file runs under it)`);
        globs = (script.match(/'[^']+'/g) || []).map(g => g.slice(1, -1));
        assert(globs.length > 0, `${SCRIPT_NAME} must pass at least one quoted glob to mocha`);
    });

    it('matches at least one file per glob', function() {
        for (const glob of globs) {
            const base    = globBase(glob);
            const pattern = globToRegExp(glob);
            const matches = listFiles(path.join(PACKAGE_ROOT, base), base).filter(f => pattern.test(f));
            assert(matches.length > 0,
                `${SCRIPT_NAME} glob '${glob}' matches no files; mocha reports ` +
                '"No test files found" and the tier runs zero assertions');
        }
    });

    it('every matched file is loadable', function() {
        // A syntax or require error in a sibling file surfaces here as a
        // throw rather than as a quietly smaller run.
        let loaded = 0;
        for (const glob of globs) {
            const base    = globBase(glob);
            const pattern = globToRegExp(glob);
            for (const rel of listFiles(path.join(PACKAGE_ROOT, base), base).filter(f => pattern.test(f))) {
                require(path.join(PACKAGE_ROOT, rel));
                loaded++;
            }
        }
        assert(loaded > 0, 'the tier must load at least one test file');
    });
});
