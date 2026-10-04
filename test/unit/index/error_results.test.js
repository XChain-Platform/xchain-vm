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
const { sanitizeError, errorResult } = require('../../../src/index/error_results.js');

describe('error results', function () {
    describe('sanitizeError', function () {
        it('uses the fallback for missing messages', function () {
            for (const message of ['', undefined, null]) {
                assert.strictEqual(sanitizeError(message), 'unknown error');
            }
        });

        it('keeps only the first line', function () {
            assert.strictEqual(sanitizeError('first line\nsecond line'), 'first line');
        });

        it('strips absolute paths with line and column suffixes', function () {
            const message = 'bad at /home/x/y.js:10:5\nsecond line';
            assert.strictEqual(sanitizeError(message), 'bad at');
        });

        it('truncates messages to 256 characters', function () {
            const message = 'a'.repeat(300);
            assert.strictEqual(sanitizeError(message), 'a'.repeat(256));
        });
    });

    describe('errorResult', function () {
        const l = { event: 'log' };
        const gasTracker = { getUsed: () => 7 };
        const emissionCollector = { getLogs: () => [l] };

        it('builds the exact failure result', function () {
            assert.deepStrictEqual(errorResult(gasTracker, emissionCollector, 'bad'), {
                success: false,
                error: 'bad',
                gasUsed: 7,
                returnValue: null,
                stateChanges: [],
                stateDeletes: [],
                emittedActions: [],
                logs: [l]
            });
        });

        it('uses a zero gas override', function () {
            const result = errorResult(gasTracker, emissionCollector, 'bad', 0);
            assert.strictEqual(result.gasUsed, 0);
        });

        it('falls back to tracked gas for a null override', function () {
            const result = errorResult(gasTracker, emissionCollector, 'bad', null);
            assert.strictEqual(result.gasUsed, 7);
        });
    });
});
