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
const { createEmitAPI } = require('./helpers/emit.js');

describe('Emit API', function() {
    describe('type validation throws (validateTypes)', function() {
        it('send: should throw on non-string destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ destination: 123, tick: 'T', quantity: '1' }), /destination must be a string/);
        });

        it('send: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ destination: 'a', tick: 99, quantity: '1' }), /tick must be a string/);
        });

        it('send: should throw on non-string quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ destination: 'a', tick: 'T', quantity: 100 }), /quantity must be a string/);
        });

        it('destroy: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.destroy({ tick: 5, quantity: '1' }), /tick must be a string/);
        });

        it('order: should throw on non-string giveAmount', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.order({ giveAmount: 100, getAmount: '50' }), /giveAmount must be a string/);
        });

        it('order: should throw on non-string getAmount', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.order({ giveAmount: '100', getAmount: 50 }), /getAmount must be a string/);
        });

        it('sweep: should throw on non-string destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.sweep({ destination: 99 }), /destination must be a string/);
        });

        it('link: should throw on non-string coin1', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1: 42, coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }), /coin1 must be a string/);
        });

        it('link: should throw on non-string coin2', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1: 'B', coin1ActionIndex: 1, coin2: 99, coin2ActionIndex: 2 }), /coin2 must be a string/);
        });

        it('message: should throw on non-string destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.message({ destination: 42 }), /destination must be a string/);
        });
    });
});
