// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const {
    TOSTRING_SIZE_METER_GATE_BLOCK_TIME,
    TOSTRING_SIZE_METER_ACTIVATION,
    toStringSizeMeterGateTime,
    isToStringSizeMeterActive,
} = require('../../../src/index/tostring_size_meter.js');

describe('toString size meter activation', function () {
    const deferred = 9999999999;

    it('exports the deferred scalar and sealed network activation map', function () {
        assert.strictEqual(TOSTRING_SIZE_METER_GATE_BLOCK_TIME, deferred);
        assert.strictEqual(Object.isSealed(TOSTRING_SIZE_METER_ACTIVATION), true);
        assert.deepStrictEqual(TOSTRING_SIZE_METER_ACTIVATION, {
            mainnet: deferred,
            testnet: deferred,
            regtest: 0,
        });
    });

    it('resolves known network gate times', function () {
        assert.strictEqual(toStringSizeMeterGateTime('mainnet'), deferred);
        assert.strictEqual(toStringSizeMeterGateTime('testnet'), deferred);
        assert.strictEqual(toStringSizeMeterGateTime('regtest'), 0);
    });

    it('resolves unknown and missing networks like mainnet', function () {
        for (const network of ['unknown', '', undefined, null]) {
            assert.strictEqual(toStringSizeMeterGateTime(network), deferred, String(network));
        }
    });

    it('arms regtest from genesis regardless of the supplied block time', function () {
        for (const blockTime of [undefined, NaN, -1, 0, deferred]) {
            assert.strictEqual(isToStringSizeMeterActive('regtest', blockTime), true, String(blockTime));
        }
    });

    it('arms deferred networks only at or after their gate', function () {
        for (const network of ['mainnet', 'testnet', 'unknown', undefined]) {
            assert.strictEqual(isToStringSizeMeterActive(network, deferred - 1), false, String(network));
            assert.strictEqual(isToStringSizeMeterActive(network, deferred), true, String(network));
            assert.strictEqual(isToStringSizeMeterActive(network, deferred + 1), true, String(network));
        }
    });

    it('rejects non-finite block times for deferred networks', function () {
        for (const blockTime of [undefined, null, NaN, Infinity, -Infinity, String(deferred)]) {
            assert.strictEqual(isToStringSizeMeterActive('mainnet', blockTime), false, String(blockTime));
        }
    });
});
