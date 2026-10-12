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
 * Read one file from the xchain-sdk commit a vendor-parity guard pins.
 *
 * The pin names an SDK commit, not the SDK tip, so the guard must read that
 * commit's blob. A developer tree and a venue hold full clones where the commit
 * is present. CI clones each sibling with --depth 1, so the pinned commit is
 * absent there even when it is an ancestor of the sibling's tip; a full sha then
 * resolves without its objects and `git show` fails. In that case fetch the one
 * pinned commit into the shallow clone and read it, rather than reading the
 * ambient tip, which would make the guard pass against a file the pin never
 * named.
 */

'use strict';

const childProcess = require('child_process');
const path = require('path');

function hasCommit(root, commit) {
    return childProcess.spawnSync(
        'git', ['-C', root, 'cat-file', '-e', commit + '^{commit}'], { stdio: 'ignore' }
    ).status === 0;
}

function isShallow(root) {
    const result = childProcess.spawnSync(
        'git', ['-C', root, 'rev-parse', '--is-shallow-repository'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return result.status === 0 && result.stdout.trim() === 'true';
}

// A lane worktree's sibling may be a clone whose origin is the main checkout on
// disk; that checkout is a second place the commit can already be.
function candidateRoots(sdkRoot) {
    const roots = [sdkRoot];
    try {
        const origin = childProcess.execFileSync(
            'git', ['-C', sdkRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }
        ).trim().replace(/^file:\/\//, '');
        if (path.isAbsolute(origin)) roots.push(origin);
    } catch (_) {
        // no origin remote: the sibling checkout is the only candidate
    }
    return roots;
}

function readPinnedSdkFile(sdkRoot, commit, sdkPath) {
    const spec = commit + ':' + sdkPath;
    for (const root of candidateRoots(sdkRoot)) {
        if (hasCommit(root, commit)) return childProcess.execFileSync('git', ['-C', root, 'show', spec]);
    }
    if (isShallow(sdkRoot)) {
        childProcess.spawnSync(
            'git', ['-C', sdkRoot, 'fetch', '--quiet', '--no-tags', '--depth', '1', 'origin', commit],
            { stdio: 'ignore', timeout: 60000 }
        );
    }
    return childProcess.execFileSync('git', ['-C', sdkRoot, 'show', spec]);
}

module.exports = { readPinnedSdkFile };
