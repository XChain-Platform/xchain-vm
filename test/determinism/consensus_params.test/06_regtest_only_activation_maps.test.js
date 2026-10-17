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
 ********************************************************************/
// @ts-nocheck

// Activations that run on regtest from genesis and stay unarmed on mainnet and testnet
// until a release cut arms them. Arming one moves consensus output, so a change here
// is a release event, never a drive-by edit.

const assert = require('assert');
const vm = require('../../../src/index.js');

const COIN_KEYS = ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet', 'BTC:testnet', 'LTC:testnet', 'DOGE:testnet'];

// A per-coin height map: the six keys in order, frozen, every entry null, on from genesis
// on regtest and off on mainnet and testnet at any height.
function assertCoinMapUnarmed(map, isActive) {
    assert.deepStrictEqual(Object.keys(map), COIN_KEYS);
    assert.ok(Object.isFrozen(map));
    for (const key of COIN_KEYS) assert.strictEqual(map[key], null, key);
    assert.strictEqual(isActive('regtest', 'BTC', 0), true);
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        assert.strictEqual(isActive('mainnet', coin, 1e9), false, `${coin}:mainnet`);
        assert.strictEqual(isActive('testnet', coin, 1e9), false, `${coin}:testnet`);
    }
}

// A per-network block-time map: sealed, regtest at 0, mainnet and testnet null.
function assertTimeMapUnarmed(map, isActive) {
    assert.deepStrictEqual(map, { mainnet: null, testnet: null, regtest: 0 });
    assert.ok(Object.isSealed(map));
    for (const [network, t, on] of [['regtest', 0, true], ['mainnet', 4102444800, false],
        ['testnet', 4102444800, false], ['unknown', 4102444800, false], [undefined, 4102444800, false]])
        assert.strictEqual(isActive(network, t), on, `${network}@${t}`);
}

describe('consensus parameters are frozen (track 8 guard)', function () {
    it('GAS_CEILING_EXHAUSTED_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.GAS_CEILING_EXHAUSTED_ACTIVATION, vm.isGasCeilingExhaustedActive);
    });

    it('RESOURCE_FAULT_SIGNAL_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.RESOURCE_FAULT_SIGNAL_ACTIVATION, vm.isResourceFaultSignalActive);
    });

    it('HOST_ERROR_STACK_STRIP_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.HOST_ERROR_STACK_STRIP_ACTIVATION, vm.isHostErrorStackStripActive);
    });

    it('HOST_FAULT_HALT_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.HOST_FAULT_HALT_ACTIVATION, vm.isHostFaultHaltActive);
    });

    it('JSON_STRINGIFY_REENTRY_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.JSON_STRINGIFY_REENTRY_ACTIVATION, vm.isJsonStringifyReentryActive);
    });

    it('LINT_SYNTAX_DEPTH_ACTIVATION is frozen and unarmed on mainnet and testnet', function () {
        assertCoinMapUnarmed(vm.LINT_SYNTAX_DEPTH_ACTIVATION, vm.isLintSyntaxDepthActive);
    });

    it('HOST_CALL_BOUNDS_ACTIVATION is sealed and unarmed on mainnet and testnet', function () {
        assertTimeMapUnarmed(vm.HOST_CALL_BOUNDS_ACTIVATION, vm.isHostCallBoundsActive);
    });

    it('PER_ELEMENT_METER_ACTIVATION is sealed and unarmed on mainnet and testnet', function () {
        assertTimeMapUnarmed(vm.PER_ELEMENT_METER_ACTIVATION, vm.isPerElementMeterActive);
    });
});
