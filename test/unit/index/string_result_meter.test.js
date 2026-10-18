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

const assert = require('assert');
const {
    STRING_RESULT_METER_ACTIVATION,
    isStringResultMeterActive,
} = require('../../../src/index/string_result_meter.js');

describe('string-result meter activation', function () {
    it('is sealed, armed on regtest from genesis and on testnet at its v0.25.0 instant', function () {
        // The v0.25.0 cut arms testnet at block time 1792432800.
        assert.deepStrictEqual(STRING_RESULT_METER_ACTIVATION,
            { mainnet: null, testnet: 1792432800, regtest: 0 });
        assert.ok(Object.isSealed(STRING_RESULT_METER_ACTIVATION));
        assert.strictEqual(isStringResultMeterActive('regtest', 0), true);
        assert.strictEqual(isStringResultMeterActive('regtest', undefined), true);
    });

    it('keeps mainnet and unknown names unarmed and arms testnet from its v0.25.0 instant', function () {
        for (const network of ['mainnet', 'signet', 'unknown',
            '__proto__', 'toString', undefined, null]) {
            assert.strictEqual(isStringResultMeterActive(network, 4000000000), false,
                String(network));
        }
        assert.strictEqual(isStringResultMeterActive('testnet', 1792432799), false);
        assert.strictEqual(isStringResultMeterActive('testnet', 1792432800), true);
    });

    it('requires a finite block time for a positive activation', function () {
        const saved = STRING_RESULT_METER_ACTIVATION.testnet;
        STRING_RESULT_METER_ACTIVATION.testnet = 100;
        try {
            for (const time of [undefined, null, NaN, Infinity, -Infinity, '100']) {
                assert.strictEqual(isStringResultMeterActive('testnet', time), false,
                    String(time));
            }
            assert.strictEqual(isStringResultMeterActive('testnet', 99), false);
            assert.strictEqual(isStringResultMeterActive('testnet', 100), true);
            assert.strictEqual(isStringResultMeterActive('testnet', 101), true);
        } finally {
            STRING_RESULT_METER_ACTIVATION.testnet = saved;
        }
    });
});
