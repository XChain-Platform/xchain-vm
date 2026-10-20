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
// Unit tests for src/consensus-runtime.js: the engine-version pin and the pure
// check/describe helpers the validator-fleet determinism gate is built on.

const assert = require('assert');
const {
    PINNED, MATH_PINNED, AST_TOOLCHAIN_PINNED, RUNTIME_ADDON_PINNED,
    REFERENCE_NODE, CONSENSUS_VERSION,
    CONSENSUS_STATUS_TOKENS, STATUS_ERROR_PREFIXES,
    checkConsensusRuntime, describeMismatch,
    checkConsensusDependencies, describeDependencyMismatch,
} = require('../../../src/consensus-runtime.js');

const MATCHING_DEPENDENCIES = {
    'isolated-vm': RUNTIME_ADDON_PINNED.isolatedVm,
    mathjs: MATH_PINNED.mathjs,
    'decimal.js': MATH_PINNED.decimaljs,
    acorn: AST_TOOLCHAIN_PINNED.acorn,
    'acorn-walk': AST_TOOLCHAIN_PINNED.acornWalk,
    astring: AST_TOOLCHAIN_PINNED.astring,
};

describe('Consensus runtime pin', function () {

    describe('frozen constants', function () {
        it('PINNED and status vocabularies are frozen', function () {
            assert.ok(Object.isFrozen(PINNED));
            assert.ok(Object.isFrozen(CONSENSUS_STATUS_TOKENS));
            assert.ok(Object.isFrozen(STATUS_ERROR_PREFIXES));
            assert.deepStrictEqual(CONSENSUS_STATUS_TOKENS, ['reverted', 'out_of_resource', 'failed']);
            assert.strictEqual(CONSENSUS_VERSION, '7');
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
            // Check the re-pin steps name the wall-clock calibration re-run.
            assert.ok(msg.includes('test/determinism/helpers/probe_wall_clock_calibration.js'));
        });
    });

    describe('checkConsensusDependencies', function () {
        it('reports ok for an exact match of every dependency pin', function () {
            assert.deepStrictEqual(checkConsensusDependencies(MATCHING_DEPENDENCIES), {
                ok: true,
                mismatches: [],
            });
        });

        it('reports drift and missing packages without throwing', function () {
            const installed = { ...MATCHING_DEPENDENCIES, mathjs: '0.0.0' };
            delete installed['decimal.js'];
            const result = checkConsensusDependencies(installed);
            assert.strictEqual(result.ok, false);
            assert.deepStrictEqual(result.mismatches, [
                { key: 'mathjs', expected: MATH_PINNED.mathjs, actual: '0.0.0' },
                { key: 'decimal.js', expected: MATH_PINNED.decimaljs, actual: undefined },
            ]);
        });

        it('checks the real installed dependency tree by default', function () {
            assert.deepStrictEqual(checkConsensusDependencies(), { ok: true, mismatches: [] });
        });
    });

    describe('describeDependencyMismatch', function () {
        it('returns the match message for ok / null results', function () {
            assert.match(describeDependencyMismatch({ ok: true }), /match the pins/);
            assert.match(describeDependencyMismatch(null), /match the pins/);
        });

        it('renders every mismatch and remediation', function () {
            const result = checkConsensusDependencies({ ...MATCHING_DEPENDENCIES, astring: '2.0.0' });
            const message = describeDependencyMismatch(result);
            assert.match(message, /CONSENSUS DEPENDENCY MISMATCH/);
            assert.match(message, /astring: installed "2.0.0" != pinned "1.9.0"/);
            assert.match(message, /package-lock\.json/);
        });
    });
});
