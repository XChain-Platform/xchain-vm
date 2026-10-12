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
const lifecycle = require('../../../src/index/block_lifecycle.js');

function stubExecutor() {
    const calls = [];
    const record = (name, result) => (...args) => {
        calls.push([name, args]);
        return result;
    };
    return {
        calls,
        beginBlock: record('beginBlock', 'begun'),
        endBlock: record('endBlock', 'ended'),
        shutdown: record('shutdown', 'down'),
    };
}

describe('block lifecycle', function () {
    describe('without an executor', function () {
        it('beginBlock sets a new empty Map', function () {
            const host = {};
            assert.strictEqual(lifecycle.beginBlock.call(host), undefined);
            assert.ok(host._blockCache instanceof Map);
            assert.strictEqual(host._blockCache.size, 0);
        });

        it('beginBlock replaces any existing cache', function () {
            const old = new Map([['a', 1]]);
            const host = { _blockCache: old };
            lifecycle.beginBlock.call(host);
            assert.notStrictEqual(host._blockCache, old);
            assert.strictEqual(host._blockCache.size, 0);
        });

        it('endBlock sets the cache to null', function () {
            const host = { _blockCache: new Map() };
            assert.strictEqual(lifecycle.endBlock.call(host), undefined);
            assert.strictEqual(host._blockCache, null);
        });

        it('shutdown resolves undefined', async function () {
            const host = {};
            const pending = lifecycle.shutdown.call(host);
            assert.ok(pending instanceof Promise);
            assert.strictEqual(await pending, undefined);
        });
    });

    describe('with an executor', function () {
        for (const [method, expected] of [['beginBlock', 'begun'], ['endBlock', 'ended']]) {
            it(`${method} delegates once and returns its result`, function () {
                const executor = stubExecutor();
                const cache = new Map([['k', 1]]);
                const host = { _executor: executor, _blockCache: cache };
                assert.strictEqual(lifecycle[method].call(host), expected);
                assert.strictEqual(executor.calls.length, 1);
                assert.strictEqual(executor.calls[0][0], method);
                assert.strictEqual(host._blockCache, cache);
            });
        }

        it('shutdown delegates once and resolves its result', async function () {
            const executor = stubExecutor();
            const cache = new Map();
            const host = { _executor: executor, _blockCache: cache };
            const pending = lifecycle.shutdown.call(host);
            assert.ok(pending instanceof Promise);
            assert.strictEqual(await pending, 'down');
            assert.strictEqual(executor.calls.length, 1);
            assert.strictEqual(executor.calls[0][0], 'shutdown');
            assert.strictEqual(host._blockCache, cache);
        });
    });
});
