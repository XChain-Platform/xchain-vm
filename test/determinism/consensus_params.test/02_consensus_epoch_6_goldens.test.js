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
const { CONSENSUS_RULES, findBannedWith, lintSource } = require('../../../src/lint-core.js');

describe('consensus epoch 6 goldens', function () {
    const source = 'with (outer) {\n  with (inner) { value; }\n}';

    it('binds epoch 6 to the banned-with consensus rule', function () {
        assert.strictEqual(CONSENSUS_VERSION, '6');
        assert.ok(CONSENSUS_RULES.has('banned-with'));
    });

    it('pins banned-with traversal and line reporting', function () {
        assert.deepStrictEqual(findBannedWith(source), [{ line: 2 }, { line: 1 }]);
    });

    it('pins the blocking lint finding shape', function () {
        const findings = lintSource(source).errors.filter(({ rule }) => rule === 'banned-with');
        assert.deepStrictEqual(findings.map(({ rule, line, severity }) => ({ rule, line, severity })), [
            { rule: 'banned-with', line: 2, severity: 'error' },
            { rule: 'banned-with', line: 1, severity: 'error' }
        ]);
        for (const finding of findings) {
            assert.match(finding.message, /^banned statement: with at line \d+;/);
        }
    });
});
