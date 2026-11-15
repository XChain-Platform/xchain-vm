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
 * Shared regtest-genesis height gate tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const { resolveRegtestGenesisHeightGate } = require('../../../src/index/height_gates/regtest_genesis.js');

describe('shared regtest-genesis height gate', function () {
    const armed = {
        'BTC:mainnet': 100,
        'BTC:testnet': 100,
        'LTC:testnet': null,
    };

    it('activates regtest from genesis independently of the map and height', function () {
        assert.strictEqual(resolveRegtestGenesisHeightGate({}, 'regtest', 'BTC', 0), true);
        assert.strictEqual(resolveRegtestGenesisHeightGate({}, 'regtest', null, NaN), true);
    });

    it('resolves armed boundaries, coercible heights and unarmed entries', function () {
        for (const network of ['mainnet', 'testnet']) {
            assert.strictEqual(resolveRegtestGenesisHeightGate(armed, network, 'BTC', 99), false);
            assert.strictEqual(resolveRegtestGenesisHeightGate(armed, network, 'BTC', 100), true);
            assert.strictEqual(resolveRegtestGenesisHeightGate(armed, network, 'BTC', 101), true);
        }
        assert.strictEqual(resolveRegtestGenesisHeightGate(armed, 'testnet', 'BTC', '100'), true);
        assert.strictEqual(resolveRegtestGenesisHeightGate(armed, 'testnet', 'LTC', 100), false);
        assert.strictEqual(resolveRegtestGenesisHeightGate(armed, 'testnet', 'DOGE', 100), false);
    });

    it('rejects invalid inputs and unknown networks', function () {
        assert.strictEqual(resolveRegtestGenesisHeightGate(armed, 'testnet', null, 100), false);
        assert.strictEqual(resolveRegtestGenesisHeightGate(armed, 'testnet', 'BTC', NaN), false);
        for (const network of ['signet', '', undefined, null]) {
            assert.strictEqual(resolveRegtestGenesisHeightGate(armed, network, 'BTC', 100), false);
        }
    });
});
