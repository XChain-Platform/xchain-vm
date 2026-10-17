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
 * Syntax-depth lint activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    LINT_SYNTAX_DEPTH_ACTIVATION,
    resolveSyntaxDepthActive,
    isLintSyntaxDepthActive,
} = require('../../../../src/index/lint_syntax_depth_heights.js');
const XChainVM = require('../../../../src/index.js');

// The v0.24.0 cut arms testnet at BTC 156908, LTC 4927400 and DOGE 68005165; mainnet stays unarmed.
const V0240_TESTNET = Object.freeze({ BTC: 156908, LTC: 4927400, DOGE: 68005165 });

describe('syntax-depth lint activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];

    it('exports a frozen map with mainnet unarmed and testnet at its v0.24.0 heights', function () {
        assert.ok(Object.isFrozen(LINT_SYNTAX_DEPTH_ACTIVATION));
        assert.deepStrictEqual(LINT_SYNTAX_DEPTH_ACTIVATION, {
            'BTC:mainnet': null,
            'LTC:mainnet': null,
            'DOGE:mainnet': null,
            'BTC:testnet': 156908,
            'LTC:testnet': 4927400,
            'DOGE:testnet': 68005165,
        });
    });

    it('is active on regtest at genesis, dark on mainnet and armed on testnet from its height', function () {
        assert.strictEqual(isLintSyntaxDepthActive('regtest', 'BTC', 0), true);
        for (const coin of coins) {
            assert.strictEqual(isLintSyntaxDepthActive('mainnet', coin, 1), false, coin + ':mainnet');
            assert.strictEqual(isLintSyntaxDepthActive('mainnet', coin, 99999999), false, coin + ':mainnet');
            assert.strictEqual(isLintSyntaxDepthActive('testnet', coin, V0240_TESTNET[coin] - 1), false, coin + ':testnet');
            assert.strictEqual(isLintSyntaxDepthActive('testnet', coin, V0240_TESTNET[coin]), true, coin + ':testnet');
        }
    });

    it('is exported by the VM entry point', function () {
        assert.strictEqual(XChainVM.LINT_SYNTAX_DEPTH_ACTIVATION, LINT_SYNTAX_DEPTH_ACTIVATION);
        assert.strictEqual(XChainVM.isLintSyntaxDepthActive, isLintSyntaxDepthActive);
    });

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isLintSyntaxDepthActive(undefined, 'BTC', 100), false);
        assert.strictEqual(isLintSyntaxDepthActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isLintSyntaxDepthActive('testnet', null, 100), false);
        assert.strictEqual(isLintSyntaxDepthActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:testnet': 100 };
        assert.strictEqual(resolveSyntaxDepthActive(armed, 'testnet', 'BTC', 99), false);
        assert.strictEqual(resolveSyntaxDepthActive(armed, 'testnet', 'BTC', 100), true);
        assert.strictEqual(resolveSyntaxDepthActive(armed, 'testnet', 'LTC', 100), false);
    });
});
