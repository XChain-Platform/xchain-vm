/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM: Boundary Test Suite
 *
 * Tests the VM at the exact edges of every configurable limit, hardcoded cap,
 * and validation threshold. Each section targets a specific boundary area
 * from the Boundary Testing Plan.
 *
 * Sections:
 *   1. Gas Ceiling Enforcement (G-1 through G-7)
 *   2. Wall-Clock Timeout (T-1 through T-4)
 *   3. Memory Limits (M-1 through M-4)
 *   4. Code Size (CS-1 through CS-6)
 *   5. State Management (S-1 through S-14)
 *   6. Emission Limits (E-1 through E-7)
 *   7. Log Limits (L-1 through L-7)
 *   8. Return Value Truncation (R-1 through R-5)
 *   9. Math Operations (MA-1 through MA-10)
 *  10. Metering & AST Injection (ME-1 through ME-7)
 *  11. Sandbox Escape Boundaries (SB-1 through SB-8)
 *  12. Gateway Parameter Boundaries (GW-1 through GW-9)
 *  13. Emit Action Field Boundaries (EA-1 through EA-8)
 *  14. Compound Interaction Boundaries
 *  15. Determinism at Boundaries
 */
// @ts-nocheck

const assert = require('assert');
const StateManager = require('../../../src/state.js');

// Boundary group 5: State Management (S-1 through S-14)

describe('Boundary: State Management', function() {

    const LIMITS = { maxStateKeys: 5, maxStateValueSize: 100, maxStateKeySize: 32 };

    it('S-1: set key count to exactly maxStateKeys', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        assert.strictEqual(sm.getChanges().changes.length, 5);
    });

    it('S-2: set key count to maxStateKeys + 1 rejects', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        assert.throws(() => sm.set('k5', 'v'), /max state keys/);
    });

    it('S-3: delete then re-add at limit succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        sm.delete('k0');
        sm.set('new_key', 'v'); // should succeed: room for one
        assert.strictEqual(sm.get('new_key'), 'v');
    });

    it('S-4: value at exactly maxStateValueSize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        // JSON.stringify of a string adds quotes: "xxx" = length + 2
        const inner = 'x'.repeat(98); // "xxx...x" = 100 bytes
        assert.strictEqual(Buffer.byteLength(JSON.stringify(inner), 'utf8'), 100);
        sm.set('key', inner);
        assert.strictEqual(sm.get('key'), inner);
    });

    it('S-5: value at maxStateValueSize + 1 byte rejects', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        const inner = 'x'.repeat(99); // "xxx...x" = 101 bytes
        assert.strictEqual(Buffer.byteLength(JSON.stringify(inner), 'utf8'), 101);
        assert.throws(() => sm.set('key', inner), /max size/);
    });
});

describe('Boundary: State Management', function() {

    const LIMITS = { maxStateKeys: 5, maxStateValueSize: 100, maxStateKeySize: 32 };

    it('S-6: multi-byte UTF-8 at value boundary rejects by byte length', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        // emoji is 4 UTF-8 bytes. We need JSON.stringify result > 100 bytes
        // JSON.stringify('emoji...') adds quotes = 2 bytes overhead
        // 25 emojis * 4 bytes = 100 bytes + 2 quotes = 102 bytes in JSON
        const emoji = '\u{1F600}';
        const val = emoji.repeat(25);
        assert(Buffer.byteLength(JSON.stringify(val), 'utf8') > 100);
        assert.throws(() => sm.set('key', val), /max size/);
    });

    it('S-7: empty string value succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', '');
        assert.strictEqual(sm.get('key'), '');
    });

    it('S-8: empty object value succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', {});
        assert.deepStrictEqual(sm.get('key'), {});
    });

    it('S-9: deeply nested object caught by size limit', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 1000 });
        let obj = { v: 'x' };
        for (let i = 0; i < 50; i++) obj = { nested: obj };
        // This will either fit within 1000 bytes or exceed; either way, no crash
        try {
            sm.set('key', obj);
            // If it fit, verify it round-trips
            assert.deepStrictEqual(sm.get('key'), obj);
        } catch (e) {
            assert(e.message.includes('max size'), e.message);
        }
    });

    it('S-10: circular reference produces clear error', function() {
        const sm = new StateManager({}, LIMITS);
        const obj = { a: 1 };
        obj.self = obj;
        assert.throws(() => sm.set('key', obj));
    });
});

describe('Boundary: State Management', function() {

    const LIMITS = { maxStateKeys: 5, maxStateValueSize: 100, maxStateKeySize: 32 };

    it('S-11: empty string key succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('', 'value');
        assert.strictEqual(sm.get(''), 'value');
        assert.strictEqual(sm.has(''), true);
    });

    it('S-12: very long key rejected by maxStateKeySize', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('x'.repeat(33), 'v'), /key exceeds max size/);
    });

    it('S-13: pre-loaded state at maxStateKeys rejects new key', function() {
        const initial = {};
        for (let i = 0; i < 5; i++) initial['k' + i] = 'v';
        const sm = new StateManager(initial, LIMITS);
        assert.throws(() => sm.set('new', 'v'), /max state keys/);
    });

    it('S-14: delete-set-delete cycle tracks keyCount correctly', function() {
        const sm = new StateManager({ a: '1' }, LIMITS);
        sm.delete('a');    // keyCount: 0
        sm.set('a', '2');  // keyCount: 1
        sm.delete('a');    // keyCount: 0
        const { changes, deletes } = sm.getChanges();
        assert.strictEqual(deletes.length, 1);
        assert(deletes.includes('a'));
        assert.strictEqual(changes.length, 0);
    });
});
