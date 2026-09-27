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
 * Optional-chain lint activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    LINT_OPTIONAL_CHAIN_ACTIVATION,
    resolveOptionalChainActive,
    isLintOptionalChainActive,
} = require('../../../src/index/lint_optional_chain_activation.js');

describe('optional-chain lint activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];
    const expectedKeys = [
        'BTC:mainnet',
        'LTC:mainnet',
        'DOGE:mainnet',
        'BTC:testnet',
        'LTC:testnet',
        'DOGE:testnet',
    ];

    it('exports a frozen map with exactly six unarmed entries', function () {
        assert.ok(Object.isFrozen(LINT_OPTIONAL_CHAIN_ACTIVATION));
        assert.deepStrictEqual(Object.keys(LINT_OPTIONAL_CHAIN_ACTIVATION), expectedKeys);
        for (const key of expectedKeys) {
            assert.strictEqual(LINT_OPTIONAL_CHAIN_ACTIVATION[key], null);
        }
    });

    it('is active on regtest at genesis', function () {
        assert.strictEqual(isLintOptionalChainActive('regtest', 'BTC', 0), true);
    });

    for (const network of ['testnet', 'mainnet']) {
        it('keeps every ' + network + ' chain unarmed', function () {
            for (const coin of coins) {
                assert.strictEqual(isLintOptionalChainActive(network, coin, 0), false);
                assert.strictEqual(isLintOptionalChainActive(network, coin, 10000000), false);
            }
        });
    }

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isLintOptionalChainActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isLintOptionalChainActive('testnet', null, 100), false);
        assert.strictEqual(isLintOptionalChainActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:testnet': 100 };
        assert.strictEqual(resolveOptionalChainActive(armed, 'testnet', 'BTC', 99), false);
        assert.strictEqual(resolveOptionalChainActive(armed, 'testnet', 'BTC', 100), true);
        assert.strictEqual(resolveOptionalChainActive(armed, 'testnet', 'BTC', 101), true);
        assert.strictEqual(resolveOptionalChainActive(armed, 'testnet', 'LTC', 100), false);
    });
});
