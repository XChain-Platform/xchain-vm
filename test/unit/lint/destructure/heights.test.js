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
 * Destructure lint activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    LINT_DESTRUCTURE_ACTIVATION,
    resolveDestructureActive,
    isLintDestructureActive,
} = require('../../../../src/index/lint_destructure_heights.js');
const XChainVM = require('../../../../src/index.js');

describe('destructure lint activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];
    const expectedKeys = [
        'BTC:mainnet',
        'LTC:mainnet',
        'DOGE:mainnet',
        'BTC:testnet',
        'LTC:testnet',
        'DOGE:testnet',
    ];

    it('exports a frozen map with mainnet unarmed and every testnet chain armed', function () {
        assert.ok(Object.isFrozen(LINT_DESTRUCTURE_ACTIVATION));
        assert.deepStrictEqual(Object.keys(LINT_DESTRUCTURE_ACTIVATION), expectedKeys);
        for (const coin of coins) {
            assert.strictEqual(LINT_DESTRUCTURE_ACTIVATION[`${coin}:mainnet`], null);
            const armed = LINT_DESTRUCTURE_ACTIVATION[`${coin}:testnet`];
            assert.ok(Number.isSafeInteger(armed) && armed > 1, `${coin}:testnet armed height`);
        }
    });

    it('is active on regtest at genesis', function () {
        assert.strictEqual(isLintDestructureActive('regtest', 'BTC', 0), true);
    });

    it('is exported by the VM entry point', function () {
        assert.strictEqual(XChainVM.LINT_DESTRUCTURE_ACTIVATION, LINT_DESTRUCTURE_ACTIVATION);
        assert.strictEqual(XChainVM.isLintDestructureActive, isLintDestructureActive);
    });

    it('keeps every mainnet chain unarmed and activates each testnet chain at its armed height', function () {
        for (const coin of coins) {
            assert.strictEqual(isLintDestructureActive('mainnet', coin, 0), false);
            assert.strictEqual(isLintDestructureActive('mainnet', coin, 10000000), false);
            const armed = LINT_DESTRUCTURE_ACTIVATION[`${coin}:testnet`];
            assert.strictEqual(isLintDestructureActive('testnet', coin, 1), false, coin);
            assert.strictEqual(isLintDestructureActive('testnet', coin, armed - 1), false, coin);
            assert.strictEqual(isLintDestructureActive('testnet', coin, armed), true, coin);
            assert.strictEqual(isLintDestructureActive('testnet', coin, armed + 1), true, coin);
        }
    });

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isLintDestructureActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isLintDestructureActive('testnet', null, 100), false);
        assert.strictEqual(isLintDestructureActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:testnet': 100 };
        assert.strictEqual(resolveDestructureActive(armed, 'testnet', 'BTC', 99), false);
        assert.strictEqual(resolveDestructureActive(armed, 'testnet', 'BTC', 100), true);
        assert.strictEqual(resolveDestructureActive(armed, 'testnet', 'BTC', 101), true);
        assert.strictEqual(resolveDestructureActive(armed, 'testnet', 'LTC', 100), false);
    });
});
