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
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource } = require('../../../src/lint_core.js');
const corpus = require('../../fixtures/lint/optional_chain_bypass_corpus.json');

describe('optional-chain pre-activation lint verdicts', function () {
    it('contains exactly eight cases', function () {
        assert.strictEqual(corpus.cases.length, 8);
    });

    for (const { source, legacyRules } of corpus.cases) {
        it('reproduces legacy rules for ' + source, function () {
            const defaultRules = lintSource(source).errors.map((error) => error.rule);
            const disabledRules = lintSource(source, { globalAlias: false })
                .errors.map((error) => error.rule);

            assert.deepStrictEqual(defaultRules, legacyRules);
            assert.deepStrictEqual(disabledRules, legacyRules);
        });
    }
});
