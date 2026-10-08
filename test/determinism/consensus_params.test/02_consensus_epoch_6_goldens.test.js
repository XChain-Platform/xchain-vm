/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const { CONSENSUS_VERSION } = require('../../../src/consensus-runtime.js');
const {
    CONSENSUS_RULES,
    MAX_NESTING_DEPTH,
    findBannedWith,
    findNestingDepth,
    lintSource
} = require('../../../src/lint-core.js');

describe('consensus epoch 7 goldens', function () {
    const source = 'module.exports = ' + '('.repeat(65) + '1' + ')'.repeat(65) + ';';
    const epoch6Source = 'with (outer) {\n  with (inner) { value; }\n}';

    it('binds epoch 7 to the nesting-depth consensus rule', function () {
        assert.strictEqual(CONSENSUS_VERSION, '7');
        assert.strictEqual(MAX_NESTING_DEPTH, 64);
        assert.ok(CONSENSUS_RULES.has('nesting-depth'));
    });

    it('pins nesting-depth scanning and line reporting', function () {
        assert.deepStrictEqual(findNestingDepth(source), [{ line: 1, depth: 65 }]);
    });

    it('pins the blocking lint finding shape', function () {
        const findings = lintSource(source).errors.filter(({ rule }) => rule === 'nesting-depth');
        assert.deepStrictEqual(findings.map(({ rule, line, severity }) => ({ rule, line, severity })), [
            { rule: 'nesting-depth', line: 1, severity: 'error' }
        ]);
        for (const finding of findings) {
            assert.strictEqual(finding.message, 'nesting depth exceeds limit (64) at line 1');
        }
    });

    it('retains the epoch 6 banned-with traversal golden', function () {
        assert.deepStrictEqual(findBannedWith(epoch6Source), [{ line: 2 }, { line: 1 }]);
        const findings = lintSource(epoch6Source).errors.filter(({ rule }) => rule === 'banned-with');
        assert.deepStrictEqual(findings.map(({ rule, line, severity }) => ({ rule, line, severity })), [
            { rule: 'banned-with', line: 2, severity: 'error' },
            { rule: 'banned-with', line: 1, severity: 'error' }
        ]);
    });
});
