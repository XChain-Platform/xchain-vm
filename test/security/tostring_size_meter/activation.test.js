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
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
const activation = require('../../../src/index/tostring_size_meter.js');

describe('toString size meter public activation', function () {
    const deferred = 9999999999;

    it('re-exports the authored activation module without copying its values', function () {
        for (const name of [
            'TOSTRING_SIZE_METER_GATE_BLOCK_TIME',
            'TOSTRING_SIZE_METER_ACTIVATION',
            'toStringSizeMeterGateTime',
            'isToStringSizeMeterActive',
        ]) assert.strictEqual(XChainVM[name], activation[name], name);
    });

    it('keeps mainnet unarmed and arms testnet at its v0.25.0 instant while regtest is active from genesis', function () {
        // The v0.25.0 cut arms testnet at block time 1792416600.
        const testnetArmed = 1792416600;
        assert.strictEqual(XChainVM.TOSTRING_SIZE_METER_GATE_BLOCK_TIME, deferred);
        assert.ok(Object.isSealed(XChainVM.TOSTRING_SIZE_METER_ACTIVATION));
        assert.deepStrictEqual(XChainVM.TOSTRING_SIZE_METER_ACTIVATION, {
            mainnet: deferred,
            testnet: testnetArmed,
            regtest: 0,
        });
        assert.strictEqual(XChainVM.isToStringSizeMeterActive('regtest', 0), true);
        assert.strictEqual(XChainVM.isToStringSizeMeterActive('mainnet', 4000000000), false);
        assert.strictEqual(XChainVM.isToStringSizeMeterActive('testnet', testnetArmed - 1), false);
        assert.strictEqual(XChainVM.isToStringSizeMeterActive('testnet', testnetArmed), true);
    });

    it('fails unknown networks to the unarmed mainnet sentinel', function () {
        for (const network of ['unknown', '', undefined, null]) {
            assert.strictEqual(XChainVM.toStringSizeMeterGateTime(network), deferred, String(network));
            assert.strictEqual(XChainVM.isToStringSizeMeterActive(network, 4000000000), false, String(network));
        }
    });
});
