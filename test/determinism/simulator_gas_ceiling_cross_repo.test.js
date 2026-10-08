'use strict';

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
 * Parity gate for the toolkit simulator's top-level gas ceiling.
 *
 * The ceiling decides whether a heavy call ends out_of_gas and caps the gasUsed
 * `xchain-foundry simulate` reports. The chain states it three times in the
 * indexer: GAS_CEILING in actions/execute/index.js (module-private, so read as
 * source), gasCeiling in the actions/index.js VM options, and the constructor
 * clamp in actions/deploy/constants.js. Layer 1 pins the simulator value in
 * repo; layer 2 compares it with every indexer copy, with the same sibling
 * handling as simulator_defaults_cross_repo.test.js.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { ContractSimulator, DEFAULT_GAS_CEILING } = require('../../src/toolkit/simulator.js');
const { estimateGas } = require('../../src/toolkit/gate.js');

const GOLDEN_GAS_CEILING = 1000000;

// Walk up to the nearest package.json, so the file survives a move between directories.
const REPO_ROOT = (function () {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const up = path.dirname(dir);
        if (up === dir) throw new Error('no package.json above ' + __dirname);
        dir = up;
    }
    return dir;
})();
const PLATFORM_ROOT = path.dirname(REPO_ROOT);

// Skip on a standalone clone, but fail where the sibling repos are required present.
function siblingOrSkip(ctx, absPath, what) {
    if (fs.existsSync(absPath)) return true;
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') {
        assert.fail('simulator gas ceiling parity gate cannot run: ' + what + ' missing at ' +
            absPath + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
    }
    ctx.skip();
    return false;
}

// Read the one literal a source states for a key, failing loud on any other shape.
function scrapeOne(rel, re, what) {
    const file = path.join(PLATFORM_ROOT, rel);
    const hits = [...fs.readFileSync(file, 'utf8').matchAll(re)];
    assert.strictEqual(hits.length, 1, rel + ': expected exactly one `' + what + '` literal, found ' +
        hits.length + '; re-point this scrape rather than deleting it');
    return Number(hits[0][1]);
}

function assertMatchesChain(rel, onChain) {
    assert.strictEqual(onChain, DEFAULT_GAS_CEILING, rel + ' enforces a ceiling of ' + onChain +
        ' but the toolkit simulator uses ' + DEFAULT_GAS_CEILING + '; move both, or move neither');
}

describe('toolkit simulator gas ceiling agrees with the chain that enforces it', function () {

    it('pins the simulator default ceiling at the golden value', function () {
        assert.strictEqual(DEFAULT_GAS_CEILING, GOLDEN_GAS_CEILING);
        assert.strictEqual(new ContractSimulator().gasCeiling, DEFAULT_GAS_CEILING);
    });

    it('caps the gate gas suggestion at the same ceiling', function () {
        // gate.js keeps its own literal so the static gate never loads the isolate.
        const heavy = 'for (;;) {}\n'.repeat(200);
        assert.strictEqual(estimateGas(heavy).suggested, DEFAULT_GAS_CEILING);
    });

    it('sibling xchain-indexer execute, VM options and deploy copies match the simulator', function () {
        const copies = [
            [path.join('xchain-indexer', 'src', 'actions', 'execute', 'index.js'),
                /^const GAS_CEILING = (\d+);/gm, 'const GAS_CEILING = <n>;'],
            [path.join('xchain-indexer', 'src', 'actions', 'index.js'),
                /^\s*gasCeiling:\s*(\d+),/gm, 'gasCeiling: <n>,'],
            [path.join('xchain-indexer', 'src', 'actions', 'deploy', 'constants.js'),
                /^const GAS_CEILING = (\d+);/gm, 'const GAS_CEILING = <n>;']
        ];
        for (const [rel, re, what] of copies) {
            if (!siblingOrSkip(this, path.join(PLATFORM_ROOT, rel), rel)) return;
            assertMatchesChain(rel, scrapeOne(rel, re, what));
        }
    });
});
