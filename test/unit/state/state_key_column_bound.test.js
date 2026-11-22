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
 * State keys must fit the indexer's contract_state.state_key column, VARCHAR(256) in
 * utf8mb3. A key of 257 to 1024 characters, or one holding a code point above U+FFFF,
 * used to pass the VM's 1024-byte guard and then fail the indexer's INSERT, halting
 * every indexer at that block. With the rejectUnstorableKeys option on (the
 * STATE_KEY_STORABLE_ACTIVATION gate), set() refuses it as an ordinary contract error;
 * with it off, set() behaves exactly as before.
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const StateManager = require('../../../src/state.js');
const { buildStateAPI } = require('../../../src/gateway/accessors.js');

const LIMITS = { maxStateKeys: 10, maxStateValueSize: 1024 };
const LEGACY = { rejectNulKeys: true, normalizeKeys: true };
const GATED = { rejectNulKeys: true, normalizeKeys: true, rejectUnstorableKeys: true };
const TOO_LONG = /^Error: state key exceeds max length \(256 characters\)$/;
const ASTRAL = /^Error: state key contains a code point above U\+FFFF$/;
const EMOJI = '😀';

describe('StateManager: keys fit the state_key column once the gate is on', function () {

    it('accepts 256 characters, including 3-byte ones, and refuses 257', function () {
        const sm = new StateManager({}, LIMITS, GATED);
        sm.set('a'.repeat(256), 1);
        sm.set('中'.repeat(256), 1);
        assert.throws(() => sm.set('a'.repeat(257), 1), TOO_LONG);
        assert.throws(() => sm.set('a'.repeat(1024), 1), TOO_LONG);
    });

    it('refuses any code point above U+FFFF, even in a short key', function () {
        const sm = new StateManager({}, LIMITS, GATED);
        assert.throws(() => sm.set(EMOJI, 1), ASTRAL);
        assert.throws(() => sm.set('k' + EMOJI.repeat(200), 1), ASTRAL);
        sm.set('￿', 1);
    });

    it('keeps the older guards and their text ahead of the column bound', function () {
        const sm = new StateManager({}, LIMITS, GATED);
        assert.throws(() => sm.set('中'.repeat(342), 1), /^Error: state key exceeds max size \(1024 bytes\)$/);
        assert.throws(() => sm.set('\u0000'.repeat(300), 1), /^Error: state key contains a NUL \(0x00\) byte$/);
    });

    it('charges the state-write gas before the bound, as for every older key guard', function () {
        const charges = [];
        const tracker = { charge: (n) => charges.push(n) };
        const sm = new StateManager({}, LIMITS, GATED);
        const api = buildStateAPI(tracker, sm, { VM_STATE_WRITE: 7, VM_STATE_DELETE: 5 }).state;
        api.set('a'.repeat(256), 1);
        assert.throws(() => api.set('a'.repeat(257), 1), TOO_LONG);
        assert.throws(() => api.set(EMOJI, 1), ASTRAL);
        assert.throws(() => api.set('a\u0000', 1), /NUL/);
        assert.deepStrictEqual(charges, [7, 7, 7, 7]);
    });

    it('writes nothing for a refused key', function () {
        const sm = new StateManager({}, LIMITS, GATED);
        assert.throws(() => sm.set('a'.repeat(257), 1), TOO_LONG);
        assert.strictEqual(sm.has('a'.repeat(257)), false);
        assert.deepStrictEqual(sm.getChanges(), { changes: [], deletes: [] });
    });

    it('leaves get, has and a no-op delete of a long key unchanged', function () {
        const sm = new StateManager({}, LIMITS, GATED);
        const long = 'a'.repeat(300);
        assert.strictEqual(sm.get(long), null);
        assert.strictEqual(sm.has(long), false);
        assert.strictEqual(sm.delete(long), false);
        assert.strictEqual(sm.delete(EMOJI), false);
        assert.deepStrictEqual(sm.getChanges(), { changes: [], deletes: [] });
    });
});

describe('StateManager: keys beyond the column pass while the gate is off', function () {

    it('stores a 257-character key and an astral key exactly as before', function () {
        for (const opts of [undefined, {}, LEGACY]) {
            const sm = new StateManager({}, LIMITS, opts);
            sm.set('a'.repeat(257), 1);
            sm.set('k' + EMOJI, 2);
            assert.deepStrictEqual(sm.getChanges(), {
                changes: [{ key: 'a'.repeat(257), value: 1 }, { key: 'k' + EMOJI, value: 2 }],
                deletes: [],
            });
        }
    });

    it('still bounds keys by the 1024-byte size guard', function () {
        const sm = new StateManager({}, LIMITS, LEGACY);
        assert.throws(() => sm.set('a'.repeat(1025), 1), /^Error: state key exceeds max size \(1024 bytes\)$/);
    });
});
