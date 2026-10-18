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

// The v0.24.0 cut arms each testnet chain at these heights; mainnet stays null.
const V0240_TESTNET = { BTC: 156908, LTC: 4927400, DOGE: 68005165 };
// The v0.25.0 cut arms the maps that landed after v0.24.0 at these heights.
const V0250_TESTNET = { BTC: 157053, LTC: 4928170, DOGE: 68008790 };

// A per-coin height map: the six keys in order, frozen, every mainnet entry null, on from
// genesis on regtest, off on mainnet at any height, and on testnet from its armed height.
function assertCoinMapUnarmed(map, isActive, TESTNET = V0240_TESTNET) {
    assert.deepStrictEqual(Object.keys(map), COIN_KEYS);
    assert.ok(Object.isFrozen(map));
    for (const key of COIN_KEYS) {
        const [coin, network] = key.split(':');
        assert.strictEqual(map[key], network === 'testnet' ? TESTNET[coin] : null, key);
    }
    assert.strictEqual(isActive('regtest', 'BTC', 0), true);
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        assert.strictEqual(isActive('mainnet', coin, 1e9), false, `${coin}:mainnet`);
        assert.strictEqual(isActive('testnet', coin, TESTNET[coin] - 1), false, `${coin}:testnet below`);
        assert.strictEqual(isActive('testnet', coin, TESTNET[coin]), true, `${coin}:testnet at`);
    }
}

// A per-network block-time map: sealed, regtest at 0, mainnet and testnet null.
function assertTimeMapUnarmed(map, isActive) {
    // The v0.24.0 cut arms testnet at its shared change instant; mainnet stays null.
    assert.deepStrictEqual(map, { mainnet: null, testnet: 1792303200, regtest: 0 });
    assert.ok(Object.isSealed(map));
    for (const [network, t, on] of [['regtest', 0, true], ['mainnet', 4102444800, false],
        ['testnet', 1792303199, false], ['testnet', 1792303200, true],
        ['unknown', 4102444800, false], [undefined, 4102444800, false]])
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
        assertCoinMapUnarmed(vm.HOST_FAULT_HALT_ACTIVATION, vm.isHostFaultHaltActive, V0250_TESTNET);
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
