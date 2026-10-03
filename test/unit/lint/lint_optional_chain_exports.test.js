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
 * Optional-chain lint public export tests
 ********************************************************************/
'use strict';

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
const activation = require('../../../src/index/lint_optional_chain_heights.js');

describe('optional-chain lint public exports', function () {
    const expectedKeys = [
        'BTC:mainnet',
        'LTC:mainnet',
        'DOGE:mainnet',
        'BTC:testnet',
        'LTC:testnet',
        'DOGE:testnet',
    ];

    it('exports the frozen activation map by identity', function () {
        const map = XChainVM.LINT_OPTIONAL_CHAIN_ACTIVATION;
        assert.strictEqual(map, activation.LINT_OPTIONAL_CHAIN_ACTIVATION);
        assert.ok(Object.isFrozen(map));
        assert.deepStrictEqual(Object.keys(map), expectedKeys);
        const armed = { 'BTC:testnet': 154971, 'LTC:testnet': 4905844, 'DOGE:testnet': 67961578 };
        for (const key of expectedKeys) assert.strictEqual(map[key], armed[key] ?? null);
    });

    it('exports the optional-chain activation resolver', function () {
        assert.strictEqual(
            XChainVM.isLintOptionalChainActive,
            activation.isLintOptionalChainActive
        );
        assert.strictEqual(XChainVM.isLintOptionalChainActive('regtest', 'BTC', 0), true);
        assert.strictEqual(XChainVM.isLintOptionalChainActive('testnet', 'BTC', 154970), false);
        assert.strictEqual(XChainVM.isLintOptionalChainActive('testnet', 'BTC', 154971), true);
        assert.strictEqual(XChainVM.isLintOptionalChainActive('mainnet', 'DOGE', 10000000), false);
    });
});
