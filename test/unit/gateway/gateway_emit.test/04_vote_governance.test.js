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
const { createEmitAPI, SCHEDULE } = require('./helpers/emit.js');

describe('Emit API', function() {
    describe('emit.vote version 1 (cast a ballot)', function() {
        it('should queue VOTE with valid ballot params', function() {
            const { emit, collector } = createEmitAPI();
            emit.vote({ version: 1, pollRef: 'poll-1', ballot: 'yes' });
            const actions = collector.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].action, 'VOTE');
            assert.strictEqual(actions[0].params.pollRef, 'poll-1');
            assert.strictEqual(actions[0].params.ballot, 'yes');
        });

        it('should charge VM_EMISSION', function() {
            const { emit, gasTracker } = createEmitAPI();
            emit.vote({ version: 1, pollRef: 'poll-1', ballot: 'yes' });
            assert.strictEqual(gasTracker.getUsed(), SCHEDULE.VM_EMISSION);
        });

        it('should throw on missing pollRef', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 1, ballot: 'yes' }), /pollRef/);
        });

        it('should throw on missing ballot', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 1, pollRef: 'poll-1' }), /ballot/);
        });

        it('should throw on non-string ballot', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 1, pollRef: 'poll-1', ballot: 7 }), /ballot must be a string/);
        });
    });
});

describe('Emit API', function() {
    describe('emit.vote version 0 (create a poll)', function() {
        it('should queue VOTE with valid poll-creation params', function() {
            const { emit, collector } = createEmitAPI();
            emit.vote({ version: 0, tick: 'POLL', endBlock: 1000, options: 'yes,no' });
            const actions = collector.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].action, 'VOTE');
            assert.strictEqual(actions[0].params.tick, 'POLL');
            assert.strictEqual(actions[0].params.endBlock, 1000);
            assert.strictEqual(actions[0].params.options, 'yes,no');
        });

        it('should throw on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 0, endBlock: 1000, options: 'yes,no' }), /tick/);
        });

        it('should throw on missing endBlock', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 0, tick: 'POLL', options: 'yes,no' }), /endBlock/);
        });

        it('should throw on missing options', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 0, tick: 'POLL', endBlock: 1000 }), /options/);
        });

        it('should throw on non-string tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 0, tick: 5, endBlock: 1000, options: 'yes,no' }), /tick must be a string/);
        });

        it('should throw on non-string options', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 0, tick: 'POLL', endBlock: 1000, options: 5 }), /options must be a string/);
        });
    });
});

describe('Emit API', function() {
    describe('emit.vote version gate and params defaulting', function() {
        it('should throw for an unsupported version', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({ version: 2 }), /version must be 0 \(create\) or 1 \(ballot\)/);
        });

        it('should throw when version is absent (NaN after Number())', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote({}), /version must be 0 \(create\) or 1 \(ballot\)/);
        });

        it('non-object params default to {}, then fail the version gate', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote('not an object'), /version must be 0 \(create\) or 1 \(ballot\)/);
        });

        it('null params default to {}, then fail the version gate', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.vote(null), /version must be 0 \(create\) or 1 \(ballot\)/);
        });

        it('a valid object is not reset: its own version survives the defaulting check', function() {
            const { emit, collector } = createEmitAPI();
            emit.vote({ version: 1, pollRef: 'poll-1', ballot: 'yes' });
            assert.strictEqual(collector.getActions()[0].params.version, 1);
        });

        // A non-object, non-null params (typeof !== 'object') must still be
        // defaulted to {} before .version is read. A non-object carrier with
        // its own "version"/"pollRef"/"ballot" own properties proves the
        // defaulting actually ran: if it did not, those spoofed fields would
        // leak through and the vote would take the version-1 branch instead
        // of falling through to the version-gate error.
        it('should default a non-object carrier before reading its spoofed version field', function() {
            const { emit } = createEmitAPI();
            const spoofed = function() {};
            spoofed.version = 1;
            spoofed.pollRef = 'poll-1';
            spoofed.ballot = 'yes';
            assert.throws(() => emit.vote(spoofed), /version must be 0 \(create\) or 1 \(ballot\)/);
        });
    });
});
