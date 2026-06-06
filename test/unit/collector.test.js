// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const EmissionCollector = require('../../src/collector.js');

describe('EmissionCollector', function() {

    it('should collect emitted actions', function() {
        const ec = new EmissionCollector(50);
        ec.add('SEND', { destination: 'addr', tick: 'T', quantity: '10' });
        assert.strictEqual(ec.getActions().length, 1);
        assert.strictEqual(ec.getActions()[0].action, 'SEND');
    });

    it('should enforce emission limit', function() {
        const ec = new EmissionCollector(3);
        ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        ec.add('SEND', { destination: 'b', tick: 'T', quantity: '1' });
        ec.add('SEND', { destination: 'c', tick: 'T', quantity: '1' });
        assert.throws(() => ec.add('SEND', { destination: 'd', tick: 'T', quantity: '1' }), /emission limit/);
    });

    it('should copy params to prevent mutation', function() {
        const ec = new EmissionCollector(50);
        const params = { destination: 'addr', tick: 'T', quantity: '10' };
        ec.add('SEND', params);
        params.quantity = '999';
        assert.strictEqual(ec.getActions()[0].params.quantity, '10');
    });

    it('should collect logs', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('hello world');
        assert.strictEqual(ec.getLogs().length, 1);
        assert.strictEqual(ec.getLogs()[0], 'hello world');
    });

    it('should cap logs at 100', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 150; i++) {
            ec.addLog('log ' + i);
        }
        assert.strictEqual(ec.getLogs().length, 100);
        assert.strictEqual(ec.isLogFull(), true);
    });

    it('should truncate long log messages', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('x'.repeat(2000));
        assert(ec.getLogs()[0].length <= 1040);  // 1024 + '...(truncated)'
        assert(ec.getLogs()[0].endsWith('...(truncated)'));
    });

    it('should track log count', function() {
        const ec = new EmissionCollector(50);
        assert.strictEqual(ec.getLogCount(), 0);
        ec.addLog('a');
        ec.addLog('b');
        assert.strictEqual(ec.getLogCount(), 2);
    });

    it('should allow exactly maxEmissions actions', function() {
        const ec = new EmissionCollector(3);
        ec.add('SEND', { a: '1' });
        ec.add('SEND', { a: '2' });
        ec.add('SEND', { a: '3' });
        assert.strictEqual(ec.getActions().length, 3);
    });

    it('should accept the 100th log and reject the 101st', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 100; i++) ec.addLog('msg');
        assert.strictEqual(ec.getLogCount(), 100);
        assert.strictEqual(ec.isLogFull(), true);
        ec.addLog('rejected');
        assert.strictEqual(ec.getLogCount(), 100); // Still 100
    });

    it('should not truncate message of exactly 1024 bytes', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1024);
        ec.addLog(msg);
        assert.strictEqual(ec.getLogs()[0].length, 1024);
        assert(!ec.getLogs()[0].includes('truncated'));
    });

    it('should truncate message of 1025 bytes', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1025);
        ec.addLog(msg);
        assert(ec.getLogs()[0].endsWith('...(truncated)'));
        // 1024 chars + '...(truncated)' = 1024 + 14 = 1038
        assert.strictEqual(ec.getLogs()[0].length, 1024 + '...(truncated)'.length);
    });

    it('should not report logFull when under 100', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 99; i++) ec.addLog('msg');
        assert.strictEqual(ec.isLogFull(), false);
    });

    it('should handle empty params in add', function() {
        const ec = new EmissionCollector(50);
        ec.add('FILE', {});
        const params = ec.getActions()[0].params;
        assert.strictEqual(Object.keys(params).length, 0);
    });

    it('should return actions array directly', function() {
        const ec = new EmissionCollector(50);
        ec.add('SEND', { x: '1' });
        const actions = ec.getActions();
        assert.strictEqual(actions, ec.getActions()); // Same reference
    });

    it('should truncate multi-byte characters by byte length, not char count', function() {
        const ec = new EmissionCollector(50);
        // Each emoji is 4 UTF-8 bytes. 256 emojis = 1024 bytes exactly.
        const emoji = '\u{1F600}';
        const atLimit = emoji.repeat(256);
        assert.strictEqual(Buffer.byteLength(atLimit, 'utf8'), 1024);
        ec.addLog(atLimit);
        assert(!ec.getLogs()[0].includes('truncated'), 'exactly 1024 bytes should not truncate');

        // 257 emojis = 1028 bytes, over limit
        const overLimit = emoji.repeat(257);
        ec.addLog(overLimit);
        assert(ec.getLogs()[1].includes('...(truncated)'), 'over 1024 bytes should truncate');
        // Truncated result must not contain replacement characters
        assert(!ec.getLogs()[1].includes('\uFFFD'), 'should not produce replacement characters');
    });
});
