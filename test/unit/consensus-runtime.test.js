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
// Unit tests for src/consensus-runtime.js — the engine-version pin + the pure
// check/describe helpers the validator-fleet determinism gate is built on.

const assert = require('assert');
const {
    PINNED, REFERENCE_NODE, CONSENSUS_VERSION,
    CONSENSUS_STATUS_TOKENS, STATUS_ERROR_PREFIXES,
    checkConsensusRuntime, describeMismatch,
} = require('../../src/consensus-runtime.js');

describe('Consensus runtime pin', function () {

    describe('frozen constants', function () {
        it('PINNED and status vocabularies are frozen', function () {
            assert.ok(Object.isFrozen(PINNED));
            assert.ok(Object.isFrozen(CONSENSUS_STATUS_TOKENS));
            assert.ok(Object.isFrozen(STATUS_ERROR_PREFIXES));
            assert.deepStrictEqual(CONSENSUS_STATUS_TOKENS, ['reverted', 'out_of_resource', 'failed']);
            assert.strictEqual(CONSENSUS_VERSION, '2');
            assert.strictEqual(REFERENCE_NODE, 'v22.22.3');
        });
    });

    describe('checkConsensusRuntime', function () {
        it('reports ok for an exact match of the pin', function () {
            const res = checkConsensusRuntime({ ...PINNED });
            assert.strictEqual(res.ok, true);
            assert.deepStrictEqual(res.mismatches, []);
        });
        it('lists each mismatching key with expected and actual', function () {
            const bad = { ...PINNED, v8: '0.0.0', icu: undefined };
            const res = checkConsensusRuntime(bad);
            assert.strictEqual(res.ok, false);
            const keys = res.mismatches.map(m => m.key);
            assert.ok(keys.includes('v8'));
            assert.ok(keys.includes('icu'));
            const v8 = res.mismatches.find(m => m.key === 'v8');
            assert.strictEqual(v8.expected, PINNED.v8);
            assert.strictEqual(v8.actual, '0.0.0');
        });
        it('defaults to process.versions when called with no argument', function () {
            const res = checkConsensusRuntime();
            assert.ok(typeof res.ok === 'boolean');
            assert.ok(Array.isArray(res.mismatches));
        });
    });

    describe('describeMismatch', function () {
        it('returns the match message for ok / null results', function () {
            assert.match(describeMismatch({ ok: true }), /matches the pin/);
            assert.match(describeMismatch(null), /matches the pin/);
        });
        it('renders a fork-warning naming each mismatch and the canonical runtime', function () {
            const res = checkConsensusRuntime({ ...PINNED, v8: '9.9.9' });
            const msg = describeMismatch(res);
            assert.match(msg, /CONSENSUS RUNTIME MISMATCH/);
            assert.match(msg, /v8: running "9.9.9" != pinned/);
            assert.ok(msg.includes(REFERENCE_NODE));
        });
    });
});
