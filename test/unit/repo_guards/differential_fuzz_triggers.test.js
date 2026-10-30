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
 * The differential-fuzz gate's push and pull_request path filters.
 *
 * The cross-build legs are the only check that diffs arm64, glibc and musl
 * consensus hashes, so a source file left out of the filter reaches develop
 * with no cross-build run until the weekly cron. Both triggers must carry the
 * same list, and that list must reach every file under src/.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT     = path.join(__dirname, '../../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/vm-differential-fuzz.yml');

// Read the `paths:` entries under one top-level trigger of the `on:` block.
function triggerPaths(yaml, trigger) {
    const block = yaml.match(new RegExp('^  ' + trigger + ':\\n((?:    .*\\n|\\s*\\n)+)', 'm'));
    assert.ok(block, 'no on.' + trigger + ' block in the workflow');
    const paths = block[1].match(/^    paths:\n((?:      - .*\n)+)/m);
    assert.ok(paths, 'no paths list under on.' + trigger);
    return paths[1].trim().split('\n').map((line) => line.replace(/^\s*- /, '').trim());
}

// Match one repo-relative file against a filter entry (exact or a trailing /**).
function matches(entry, file) {
    if (entry.endsWith('/**')) return file.startsWith(entry.slice(0, -2));
    return entry === file;
}

describe('vm-differential-fuzz path filters', function () {
    const yaml = fs.readFileSync(WORKFLOW, 'utf8');

    it('gives push and pull_request the same path list', function () {
        assert.deepStrictEqual(triggerPaths(yaml, 'push'), triggerPaths(yaml, 'pull_request'));
    });

    it('reaches every source file under src', function () {
        const entries = triggerPaths(yaml, 'push');
        const missed = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
            .map((rel) => 'src/' + rel.split(path.sep).join('/'))
            .filter((file) => fs.statSync(path.join(ROOT, file)).isFile())
            .filter((file) => !entries.some((entry) => matches(entry, file)));
        assert.deepStrictEqual(missed, []);
    });
});
