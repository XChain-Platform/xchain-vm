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

describe('syntax-depth lint activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];

    it('exports a frozen map with every mainnet and testnet chain unarmed', function () {
        assert.ok(Object.isFrozen(LINT_SYNTAX_DEPTH_ACTIVATION));
        assert.deepStrictEqual(LINT_SYNTAX_DEPTH_ACTIVATION, {
            'BTC:mainnet': null,
            'LTC:mainnet': null,
            'DOGE:mainnet': null,
            'BTC:testnet': null,
            'LTC:testnet': null,
            'DOGE:testnet': null,
        });
    });

    it('is active on regtest at genesis and dark on every public chain', function () {
        assert.strictEqual(isLintSyntaxDepthActive('regtest', 'BTC', 0), true);
        for (const coin of coins) {
            for (const network of ['mainnet', 'testnet']) {
                assert.strictEqual(isLintSyntaxDepthActive(network, coin, 1), false, coin + ':' + network);
                assert.strictEqual(isLintSyntaxDepthActive(network, coin, 99999999), false, coin + ':' + network);
            }
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
