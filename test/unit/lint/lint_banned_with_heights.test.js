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
 * Banned-with lint activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    LINT_BANNED_WITH_ACTIVATION,
    resolveBannedWithActive,
    isLintBannedWithActive,
} = require('../../../src/index/lint_banned_with_heights.js');
const XChainVM = require('../../../src/index.js');

describe('banned-with lint activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];
    const expectedKeys = [
        'BTC:mainnet',
        'LTC:mainnet',
        'DOGE:mainnet',
        'BTC:testnet',
        'LTC:testnet',
        'DOGE:testnet',
    ];

    it('exports a frozen map with six unarmed entries', function () {
        assert.ok(Object.isFrozen(LINT_BANNED_WITH_ACTIVATION));
        assert.deepStrictEqual(Object.keys(LINT_BANNED_WITH_ACTIVATION), expectedKeys);
        for (const key of expectedKeys) {
            assert.strictEqual(LINT_BANNED_WITH_ACTIVATION[key], null);
        }
    });

    it('is active on regtest at genesis', function () {
        assert.strictEqual(isLintBannedWithActive('regtest', 'BTC', 0), true);
    });

    it('is exported by the VM entry point', function () {
        assert.strictEqual(XChainVM.LINT_BANNED_WITH_ACTIVATION, LINT_BANNED_WITH_ACTIVATION);
        assert.strictEqual(XChainVM.isLintBannedWithActive, isLintBannedWithActive);
    });

    it('keeps every mainnet and testnet chain unarmed', function () {
        for (const network of ['mainnet', 'testnet']) {
            for (const coin of coins) {
                assert.strictEqual(isLintBannedWithActive(network, coin, 0), false);
                assert.strictEqual(isLintBannedWithActive(network, coin, 10000000), false);
            }
        }
    });

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isLintBannedWithActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isLintBannedWithActive('testnet', null, 100), false);
        assert.strictEqual(isLintBannedWithActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:testnet': 100 };
        assert.strictEqual(resolveBannedWithActive(armed, 'testnet', 'BTC', 99), false);
        assert.strictEqual(resolveBannedWithActive(armed, 'testnet', 'BTC', 100), true);
        assert.strictEqual(resolveBannedWithActive(armed, 'testnet', 'BTC', 101), true);
        assert.strictEqual(resolveBannedWithActive(armed, 'testnet', 'LTC', 100), false);
    });
});
