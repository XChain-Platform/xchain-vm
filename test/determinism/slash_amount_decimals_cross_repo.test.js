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
 * Parity gate for the contract.slash amount-precision ceiling.
 *
 * The VM's MAX_SLASH_AMOUNT_DECIMALS MUST equal the indexer's MAX_TOKEN_DECIMALS
 * (xchain-indexer src/config/token_limits.js applyTokenSupplyLimits). A VM ceiling
 * above it lets the VM emit an amount the slash arithmetic cannot represent; one
 * below it re-opens the graduated-slash gap. A real change is a coordinated
 * flag-day across both repos, so a one-sided edit fails here.
 *
 * The in-repo golden pin lives in
 * test/regression/slash_amount_precision_gate_regression.test.js and runs in a
 * standalone clone; this sibling read skips when xchain-indexer is absent, and
 * XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { XChainVM } = require('../fuzz/helpers/harness.js');

// Walk up to the nearest package.json rather than counting '..' hops.
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

const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function siblingOrSkip(ctx, absPath, what) {
    if (fs.existsSync(absPath)) return true;
    if (REQUIRE_SIBLINGS) {
        assert.fail('slash-amount decimals parity gate cannot run: ' + what + ' missing at ' +
            absPath + '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
    }
    ctx.skip();
    return false;
}

// Fresh read, so a cached module from an earlier suite cannot hide an on-disk edit.
function loadFresh(absPath) {
    const resolved = require.resolve(absPath);
    delete require.cache[resolved];
    return require(resolved);
}

(XChainVM ? describe : describe.skip)('contract.slash amount ceiling equals the indexer MAX_TOKEN_DECIMALS (cross-repo)', function () {

    it('MAX_SLASH_AMOUNT_DECIMALS equals applyTokenSupplyLimits MAX_TOKEN_DECIMALS', function () {
        const rel  = path.join('xchain-indexer', 'src', 'config', 'token_limits.js');
        const file = path.join(PLATFORM_ROOT, rel);
        if (!siblingOrSkip(this, file, rel)) return;

        const { applyTokenSupplyLimits } = loadFresh(file);
        assert.strictEqual(typeof applyTokenSupplyLimits, 'function',
            rel + ' no longer exports applyTokenSupplyLimits; re-point this guard at wherever ' +
            'the indexer now sets MAX_TOKEN_DECIMALS');
        const cfg = {};
        applyTokenSupplyLimits(cfg);
        assert.ok(Number.isInteger(cfg.MAX_TOKEN_DECIMALS),
            rel + ' applyTokenSupplyLimits no longer sets MAX_TOKEN_DECIMALS; re-point this guard');
        assert.strictEqual(XChainVM.MAX_SLASH_AMOUNT_DECIMALS, cfg.MAX_TOKEN_DECIMALS,
            'VM MAX_SLASH_AMOUNT_DECIMALS diverged from the indexer MAX_TOKEN_DECIMALS');
    });
});
