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
    describe('non-object params default branch (dispenser / file / list / broadcast)', function() {
        it('dispenser: non-object params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser('not an object');
            assert.strictEqual(collector.getActions()[0].action, 'DISPENSER');
        });

        it('dispenser: null params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser(null);
            assert.strictEqual(collector.getActions()[0].action, 'DISPENSER');
        });

        it('file: non-object params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.file(42);
            assert.strictEqual(collector.getActions()[0].action, 'FILE');
        });

        it('file: null params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.file(null);
            assert.strictEqual(collector.getActions()[0].action, 'FILE');
        });

        it('list: non-object params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.list('bad');
            assert.strictEqual(collector.getActions()[0].action, 'LIST');
        });

        it('list: null params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.list(null);
            assert.strictEqual(collector.getActions()[0].action, 'LIST');
        });

        it('broadcast: non-object params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.broadcast(true);
            assert.strictEqual(collector.getActions()[0].action, 'BROADCAST');
        });

        it('broadcast: null params defaults to {}', function() {
            const { emit, collector } = createEmitAPI();
            emit.broadcast(null);
            assert.strictEqual(collector.getActions()[0].action, 'BROADCAST');
        });
    });
});
