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
    describe('object-params defaulting preserves a valid object (dispenser / file)', function() {
        it('dispenser: a valid object is recorded unchanged, not reset to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser({ rate: '1' });
            const params = collector.getActions()[0].params;
            assert.deepStrictEqual(Object.keys(params), ['rate']);
            assert.strictEqual(params.rate, '1');
        });

        it('dispenser: non-object params records an empty object, not the raw value', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser('not an object');
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('dispenser: null params records an empty object', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser(null);
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('file: a valid object is recorded unchanged, not reset to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.file({ data: 'content' });
            const params = collector.getActions()[0].params;
            assert.deepStrictEqual(Object.keys(params), ['data']);
            assert.strictEqual(params.data, 'content');
        });

        it('file: non-object params records an empty object', function() {
            // A string carrier: Object.keys() on a bare number/boolean is
            // already [] regardless of defaulting, which would not tell a
            // "never defaults" mutant apart from correct behaviour. A string
            // has its own enumerable index keys, so this only reads [] when
            // the non-object branch actually ran.
            const { emit, collector } = createEmitAPI();
            emit.file('not an object');
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('file: null params records an empty object', function() {
            const { emit, collector } = createEmitAPI();
            emit.file(null);
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });
    });
});

describe('Emit API', function() {
    describe('object-params defaulting preserves a valid object (list / broadcast)', function() {
        it('list: a valid object is recorded unchanged, not reset to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.list({ items: ['a', 'b'] });
            const params = collector.getActions()[0].params;
            assert.deepStrictEqual(Object.keys(params), ['items']);
            assert.deepStrictEqual(params.items, ['a', 'b']);
        });

        it('list: non-object params records an empty object', function() {
            const { emit, collector } = createEmitAPI();
            emit.list('bad');
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('list: null params records an empty object', function() {
            const { emit, collector } = createEmitAPI();
            emit.list(null);
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('broadcast: a valid object is recorded unchanged, not reset to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.broadcast({ data: 'msg' });
            const params = collector.getActions()[0].params;
            assert.deepStrictEqual(Object.keys(params), ['data']);
            assert.strictEqual(params.data, 'msg');
        });

        it('broadcast: non-object params records an empty object', function() {
            // A string carrier for the same reason as the file case above:
            // a bare boolean has no own enumerable keys either way.
            const { emit, collector } = createEmitAPI();
            emit.broadcast('not an object');
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });

        it('broadcast: null params records an empty object', function() {
            const { emit, collector } = createEmitAPI();
            emit.broadcast(null);
            assert.deepStrictEqual(Object.keys(collector.getActions()[0].params), []);
        });
    });
});

describe('Emit API', function() {
    describe('validateTypes coverage for fields no existing test exercised', function() {
        it('issue: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.issue({ tick: 5 }), /tick must be a string/);
        });

        it('mint: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.mint({ tick: 5, quantity: '1' }), /tick must be a string/);
        });

        it('mint: should throw on non-string quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.mint({ tick: 'T', quantity: 100 }), /quantity must be a string/);
        });

        it('dividend: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ tick: 5, dividendTick: 'D', quantity: '1' }), /tick must be a string/);
        });

        it('dividend: should throw on non-string dividendTick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ tick: 'T', dividendTick: 5, quantity: '1' }), /dividendTick must be a string/);
        });

        it('dividend: should throw on non-string quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ tick: 'T', dividendTick: 'D', quantity: 5 }), /quantity must be a string/);
        });

        it('airdrop: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.airdrop({ tick: 5, quantity: '1', listActionIndex: 1 }), /tick must be a string/);
        });

        it('airdrop: should throw on non-string quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.airdrop({ tick: 'T', quantity: 5, listActionIndex: 1 }), /quantity must be a string/);
        });

        it('callback: should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.callback({ tick: 5 }), /tick must be a string/);
        });
    });
});
