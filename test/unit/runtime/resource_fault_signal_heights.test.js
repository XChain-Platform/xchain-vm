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
 * Resource fault signal activation map and resolver tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    RESOURCE_FAULT_SIGNAL_ACTIVATION,
    resolveResourceFaultSignalActive,
    isResourceFaultSignalActive,
} = require('../../../src/index/resource_fault_signal_heights.js');
const XChainVM = require('../../../src/index.js');

describe('resource fault signal activation', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];
    const expectedKeys = [
        'BTC:mainnet',
        'LTC:mainnet',
        'DOGE:mainnet',
        'BTC:testnet',
        'LTC:testnet',
        'DOGE:testnet',
    ];

    it('exports a frozen map with every mainnet and testnet chain unarmed', function () {
        assert.ok(Object.isFrozen(RESOURCE_FAULT_SIGNAL_ACTIVATION));
        assert.deepStrictEqual(Object.keys(RESOURCE_FAULT_SIGNAL_ACTIVATION), expectedKeys);
        for (const key of expectedKeys) {
            assert.strictEqual(RESOURCE_FAULT_SIGNAL_ACTIVATION[key], null, key);
        }
    });

    it('is active on regtest at genesis', function () {
        assert.strictEqual(isResourceFaultSignalActive('regtest', 'BTC', 0), true);
        assert.strictEqual(isResourceFaultSignalActive('regtest', null, NaN), true);
    });

    it('is exported by the VM entry point', function () {
        assert.strictEqual(XChainVM.RESOURCE_FAULT_SIGNAL_ACTIVATION,
            RESOURCE_FAULT_SIGNAL_ACTIVATION);
        assert.strictEqual(XChainVM.isResourceFaultSignalActive,
            isResourceFaultSignalActive);
    });

    it('keeps every mainnet and testnet chain unarmed at any height', function () {
        for (const coin of coins) {
            for (const network of ['mainnet', 'testnet']) {
                assert.strictEqual(isResourceFaultSignalActive(network, coin, 0), false, coin + ':' + network);
                assert.strictEqual(isResourceFaultSignalActive(network, coin, 100000000), false, coin + ':' + network);
            }
        }
    });

    it('rejects an unknown network, null coin and non-finite height', function () {
        assert.strictEqual(isResourceFaultSignalActive('devnet', 'BTC', 100), false);
        assert.strictEqual(isResourceFaultSignalActive(undefined, 'BTC', 100), false);
        assert.strictEqual(isResourceFaultSignalActive('testnet', null, 100), false);
        assert.strictEqual(isResourceFaultSignalActive('testnet', 'BTC', NaN), false);
    });

    it('resolves local armed thresholds and absent keys', function () {
        const armed = { 'BTC:mainnet': 100 };
        assert.strictEqual(resolveResourceFaultSignalActive(armed, 'mainnet', 'BTC', 99), false);
        assert.strictEqual(resolveResourceFaultSignalActive(armed, 'mainnet', 'BTC', 100), true);
        assert.strictEqual(resolveResourceFaultSignalActive(armed, 'mainnet', 'BTC', 101), true);
        assert.strictEqual(resolveResourceFaultSignalActive(armed, 'mainnet', 'LTC', 100), false);
        assert.strictEqual(resolveResourceFaultSignalActive(armed, 'mainnet', 'BTC', '100'), true);
    });
});
