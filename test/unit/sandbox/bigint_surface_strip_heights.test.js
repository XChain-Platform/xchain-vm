/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * BigInt surface strip activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    BIGINT_SURFACE_STRIP_ACTIVATION,
    resolveBigIntSurfaceStripActive,
    isBigIntSurfaceStripActive,
} = require('../../../src/index/bigint_surface_strip_heights.js');
const XChainVM = require('../../../src/index.js');

describe('BigInt surface strip activation', function () {
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
        assert.ok(Object.isFrozen(BIGINT_SURFACE_STRIP_ACTIVATION));
        assert.deepStrictEqual(Object.keys(BIGINT_SURFACE_STRIP_ACTIVATION), expectedKeys);
        for (const coin of coins) {
            assert.strictEqual(BIGINT_SURFACE_STRIP_ACTIVATION[`${coin}:mainnet`], null);
            const armed = BIGINT_SURFACE_STRIP_ACTIVATION[`${coin}:testnet`];
            assert.ok(Number.isSafeInteger(armed) && armed > 1, `${coin}:testnet armed height`);
        }
    });

    it('is active on regtest at genesis', function () {
        assert.strictEqual(isBigIntSurfaceStripActive('regtest', 'BTC', 0), true);
    });

    it('is exported by the VM entry point', function () {
        assert.strictEqual(XChainVM.BIGINT_SURFACE_STRIP_ACTIVATION,
            BIGINT_SURFACE_STRIP_ACTIVATION);
        assert.strictEqual(XChainVM.isBigIntSurfaceStripActive,
            isBigIntSurfaceStripActive);
    });

    it('keeps every mainnet chain unarmed and activates each testnet chain at its armed height', function () {
        for (const coin of coins) {
            assert.strictEqual(isBigIntSurfaceStripActive('mainnet', coin, 0), false);
            assert.strictEqual(isBigIntSurfaceStripActive('mainnet', coin, 10000000), false);
            const armed = BIGINT_SURFACE_STRIP_ACTIVATION[`${coin}:testnet`];
            assert.strictEqual(isBigIntSurfaceStripActive('testnet', coin, 1), false, coin);
            assert.strictEqual(isBigIntSurfaceStripActive('testnet', coin, armed - 1), false, coin);
            assert.strictEqual(isBigIntSurfaceStripActive('testnet', coin, armed), true, coin);
            assert.strictEqual(isBigIntSurfaceStripActive('testnet', coin, armed + 1), true, coin);
        }
    });

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isBigIntSurfaceStripActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isBigIntSurfaceStripActive('testnet', null, 100), false);
        assert.strictEqual(isBigIntSurfaceStripActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:testnet': 100 };
        assert.strictEqual(resolveBigIntSurfaceStripActive(armed, 'testnet', 'BTC', 99), false);
        assert.strictEqual(resolveBigIntSurfaceStripActive(armed, 'testnet', 'BTC', 100), true);
        assert.strictEqual(resolveBigIntSurfaceStripActive(armed, 'testnet', 'BTC', 101), true);
        assert.strictEqual(resolveBigIntSurfaceStripActive(armed, 'testnet', 'LTC', 100), false);
    });
});
