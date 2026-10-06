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
const { lintSource } = require('../../../src/lint-core.js');
const { validateSyntax } = require('../../../src/syntax.js');
const corpus = require('../../fixtures/lint/optional_chain_math_leg_legacy_corpus.json');

describe('optional-chain Math leg legacy corpus', function () {
    it('contains exactly six cases', function () {
        assert.strictEqual(corpus.cases.length, 6);
    });

    for (const { source, legacyRules } of corpus.cases) {
        it('preserves the pre-activation verdict for: ' + source, function () {
            assert.deepStrictEqual(
                lintSource(source, { optionalChain: false }).errors.map((error) => error.rule),
                legacyRules
            );
            assert.deepStrictEqual(
                lintSource(source, { optionalChain: false, globalAlias: false })
                    .errors.map((error) => error.rule),
                legacyRules
            );
            assert.strictEqual(
                validateSyntax(source, { enforceLintOptionalChain: false }).valid,
                legacyRules.length === 0
            );
            assert.strictEqual(
                validateSyntax(source, {
                    enforceLintOptionalChain: false,
                    enforceLintGlobalAlias: false
                }).valid,
                legacyRules.length === 0
            );
        });
    }
});
