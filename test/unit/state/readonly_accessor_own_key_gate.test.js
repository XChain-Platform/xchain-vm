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
//
// Pins the own-key lookup gate in src/readonly-accessors.js: the activation map
// that decides, per network, whether a snapshot key naming an inherited member
// resolves as absent. Mainnet must stay unarmed so history replays unchanged.

const assert = require('assert');
const {
    ACCESSOR_OWN_KEY_ACTIVATION,
    isAccessorOwnKeyActive,
    buildPollAccessor,
} = require('../../../src/readonly-accessors.js');

describe('Read-only accessor own-key gate', function () {

    describe('ACCESSOR_OWN_KEY_ACTIVATION', function () {
        it('arms testnet and regtest from genesis and leaves mainnet unarmed', function () {
            assert.deepStrictEqual({ ...ACCESSOR_OWN_KEY_ACTIVATION }, {
                mainnet: null,
                testnet: 0,
                regtest: 0,
            });
        });
        it('is frozen so no caller can arm mainnet at runtime', function () {
            assert.ok(Object.isFrozen(ACCESSOR_OWN_KEY_ACTIVATION));
            assert.throws(() => {
                'use strict';
                ACCESSOR_OWN_KEY_ACTIVATION.mainnet = 0;
            }, TypeError);
            assert.strictEqual(ACCESSOR_OWN_KEY_ACTIVATION.mainnet, null);
        });
    });

    describe('isAccessorOwnKeyActive', function () {
        it('is off on mainnet at every block time', function () {
            for (const t of [0, 1, 1700000000, Number.MAX_SAFE_INTEGER, undefined, NaN]) {
                assert.strictEqual(isAccessorOwnKeyActive('mainnet', t), false);
            }
        });
        it('is on for testnet and regtest at every block time, including a missing one', function () {
            for (const network of ['testnet', 'regtest']) {
                for (const t of [0, 1, 1700000000, undefined, NaN]) {
                    assert.strictEqual(isAccessorOwnKeyActive(network, t), true);
                }
            }
        });
        it('resolves an unknown network or an inherited property name like mainnet', function () {
            for (const network of ['signet', '', undefined, null, 'constructor', '__proto__', 'toString']) {
                assert.strictEqual(isAccessorOwnKeyActive(network, 1700000000), false);
            }
        });
    });

    describe('the gate reaches the accessor lookups', function () {
        const snapshot = { polls: { 7: { status: 'finalized' } } };
        const ids = ['constructor', '__proto__', 'toString'];
        it('answers an inherited key as absent once the gate is armed', function () {
            const armed = buildPollAccessor(snapshot, true);
            for (const id of ids) assert.strictEqual(armed.getPollResult(id), null, `${id} resolved on an armed lookup`);
            assert.deepStrictEqual(armed.getPollResult(7), { status: 'finalized' });
        });
        it('keeps the plain index read below the gate so replay is unchanged', function () {
            const unarmed = buildPollAccessor(snapshot, false);
            assert.strictEqual(unarmed.getPollResult('constructor'), Object.prototype.constructor);
        });
    });
});
