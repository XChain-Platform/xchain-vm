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
const StateManager = require('../../src/state.js');

describe('StateManager', function() {

    const LIMITS = {
        maxStateKeys:      10,
        maxStateValueSize: 1024
    };

    it('should read initial state', function() {
        const sm = new StateManager({ foo: 'bar' }, LIMITS);
        assert.strictEqual(sm.get('foo'), 'bar');
    });

    it('should return null for missing keys', function() {
        const sm = new StateManager({}, LIMITS);
        assert.strictEqual(sm.get('missing'), null);
    });

    it('should write and read state', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', 'value');
        assert.strictEqual(sm.get('key'), 'value');
    });

    it('should overwrite existing keys', function() {
        const sm = new StateManager({ x: 'old' }, LIMITS);
        sm.set('x', 'new');
        assert.strictEqual(sm.get('x'), 'new');
    });

    it('should delete keys', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        assert.strictEqual(sm.delete('x'), true);
        assert.strictEqual(sm.get('x'), null);
        assert.strictEqual(sm.has('x'), false);
    });

    it('should return false when deleting non-existent key', function() {
        const sm = new StateManager({}, LIMITS);
        assert.strictEqual(sm.delete('missing'), false);
    });

    it('should handle delete-then-set cycle', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        sm.delete('x');
        sm.set('x', '2');
        assert.strictEqual(sm.get('x'), '2');
        assert.strictEqual(sm.has('x'), true);
    });

    it('should has() return correct values', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        assert.strictEqual(sm.has('x'), true);
        assert.strictEqual(sm.has('y'), false);
        sm.set('y', '2');
        assert.strictEqual(sm.has('y'), true);
        sm.delete('x');
        assert.strictEqual(sm.has('x'), false);
    });

    it('should enforce max key count', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 3 });
        sm.set('a', '1');
        sm.set('b', '2');
        sm.set('c', '3');
        assert.throws(() => sm.set('d', '4'), /max state keys/);
    });

    it('should enforce max value size', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 10 });
        assert.throws(() => sm.set('key', 'a'.repeat(100)), /max size/);
    });

    it('should reject null values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', null), /null or undefined/);
    });

    it('should reject undefined values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', undefined), /null or undefined/);
    });

    it('should reject NaN values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', NaN), /NaN or Infinity/);
    });

    it('should reject Infinity values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', Infinity), /NaN or Infinity/);
    });

    it('should allow empty string values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', '');
        assert.strictEqual(sm.get('key'), '');
    });

    it('should collect changes correctly', function() {
        const sm = new StateManager({ existing: 'old' }, LIMITS);
        sm.set('existing', 'new');
        sm.set('added', 'value');
        sm.delete('existing');

        const { changes, deletes } = sm.getChanges();
        // 'existing' was set then deleted; dirty map has null for it
        assert.deepStrictEqual(deletes, ['existing']);
        assert.deepStrictEqual(changes, [{ key: 'added', value: 'value' }]);
    });

    it('should store objects as values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('obj', { a: 1, b: [2, 3] });
        assert.deepStrictEqual(sm.get('obj'), { a: 1, b: [2, 3] });
    });

    it('should filter null initial state values', function() {
        const sm = new StateManager({ good: 'yes', bad: null, ugly: undefined }, LIMITS);
        assert.strictEqual(sm.get('good'), 'yes');
        assert.strictEqual(sm.get('bad'), null);  // filtered out
        assert.strictEqual(sm.has('bad'), false);
    });

    it('should track key count across delete-set cycles', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 2 });
        sm.set('a', '1');
        sm.set('b', '2');
        // At limit
        assert.throws(() => sm.set('c', '3'), /max state keys/);
        // Delete one, should free a slot
        sm.delete('a');
        sm.set('c', '3');  // should succeed
        assert.strictEqual(sm.get('c'), '3');
    });

    it('should allow setting exactly at maxStateKeys limit', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 3 });
        sm.set('a', '1');
        sm.set('b', '2');
        sm.set('c', '3');
        // All 3 should be readable
        assert.strictEqual(sm.get('a'), '1');
        assert.strictEqual(sm.get('b'), '2');
        assert.strictEqual(sm.get('c'), '3');
    });

    it('should allow value at exactly maxStateValueSize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 10 });
        // JSON.stringify('"xx"') = "xx" (4 bytes for a 2-char string with quotes)
        // We need JSON byte length == 10: '"12345678"' is 10 bytes
        sm.set('key', '12345678');
        assert.strictEqual(sm.get('key'), '12345678');
    });

    it('should reject value one byte over maxStateValueSize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 10 });
        // '"123456789"' is 11 bytes
        assert.throws(() => sm.set('key', '123456789'), /max size/);
    });

    it('should handle multi-byte UTF-8 in value size check', function() {
        // Emoji is 4 bytes in UTF-8. JSON.stringify adds quotes.
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 20 });
        // This should work if total byte length fits
        sm.set('key', '\u{1F600}');
        assert.strictEqual(sm.get('key'), '\u{1F600}');
    });

    it('should allow empty string key', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('', 'value');
        assert.strictEqual(sm.get(''), 'value');
        assert.strictEqual(sm.has(''), true);
    });

    it('should handle boolean values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('flag', true);
        assert.strictEqual(sm.get('flag'), true);
    });

    it('should handle number values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('count', 42);
        assert.strictEqual(sm.get('count'), 42);
    });

    it('should handle array values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('list', [1, 2, 3]);
        assert.deepStrictEqual(sm.get('list'), [1, 2, 3]);
    });

    it('should maintain key count after repeated delete-set on same key', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 2 });
        sm.set('a', '1');
        sm.set('b', '2');
        // Delete a, set a again
        sm.delete('a');
        sm.set('a', 'new');
        // Should still be at 2 keys, not 3
        assert.strictEqual(sm.get('a'), 'new');
        assert.throws(() => sm.set('c', '3'), /max state keys/);
    });

    it('should return changes in insertion order', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('z', '1');
        sm.set('a', '2');
        sm.set('m', '3');
        const { changes } = sm.getChanges();
        assert.strictEqual(changes[0].key, 'z');
        assert.strictEqual(changes[1].key, 'a');
        assert.strictEqual(changes[2].key, 'm');
    });

    it('should reject -Infinity values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', -Infinity), /NaN or Infinity/);
    });

    it('should reject key exceeding maxStateKeySize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeySize: 16 });
        assert.throws(() => sm.set('a'.repeat(17), 'value'), /key exceeds max size/);
    });

    it('should accept key at exactly maxStateKeySize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeySize: 16 });
        sm.set('a'.repeat(16), 'value');
        assert.strictEqual(sm.get('a'.repeat(16)), 'value');
    });

    it('should reject oversized key on delete', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeySize: 16 });
        assert.throws(() => sm.delete('a'.repeat(17)), /key exceeds max size/);
    });

    it('should use default 1024-byte key limit when maxStateKeySize not set', function() {
        const sm = new StateManager({}, LIMITS); // LIMITS has no maxStateKeySize
        assert.throws(() => sm.set('a'.repeat(1025), 'value'), /key exceeds max size/);
        sm.set('a'.repeat(1024), 'value'); // at the limit, should pass
    });

    it('should reject non-JSON-serializable values (function)', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('k', () => {}), /JSON-serializable/);
    });

    it('should reject non-JSON-serializable values (undefined via JSON.stringify)', function() {
        // JSON.stringify wraps the value. A plain undefined arg produces ""undefined""
        // but JSON.stringify(undefined) itself returns undefined (not a string).
        // We need a value that makes JSON.stringify(value) === undefined.
        // Functions are the canonical way; verify the error message.
        const sm = new StateManager({}, LIMITS);
        let caught;
        try { sm.set('k', function foo() {}); } catch (e) { caught = e; }
        assert(caught, 'should have thrown');
        assert(/JSON-serializable/.test(caught.message), caught.message);
    });
});
