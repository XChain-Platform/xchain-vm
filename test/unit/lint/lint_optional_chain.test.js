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
const fs = require('fs');
const path = require('path');
const { lintSource } = require('../../../src/lint-core.js');
const { validateSyntax } = require('../../../src/syntax.js');

const fixtureDirectory = path.join(__dirname, '../../fixtures/lint');
const activeCorpus = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, 'optional_chain_active_corpus.json'),
    'utf8'
));
const bypassCorpus = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, 'optional_chain_bypass_corpus.json'),
    'utf8'
));
const mathLegCorpus = JSON.parse(fs.readFileSync(
    path.join(fixtureDirectory, 'optional_chain_math_leg_legacy_corpus.json'),
    'utf8'
));
const legacyRulesBySource = new Map(
    [...bypassCorpus.cases, ...mathLegCorpus.cases]
        .map(({ source, legacyRules }) => [source, legacyRules])
);

describe('optional-chain lint behavior', function () {
    for (const { source, activeRules, aliasOffRules } of activeCorpus.cases) {
        it('applies active and legacy verdicts for: ' + source, function () {
            assert.deepStrictEqual(
                lintSource(source).errors.map((error) => error.rule),
                activeRules
            );
            assert.deepStrictEqual(
                lintSource(source, { globalAlias: false }).errors.map((error) => error.rule),
                aliasOffRules
            );
            assert.strictEqual(validateSyntax(source).valid, activeRules.length === 0);
            assert.ok(legacyRulesBySource.has(source), 'missing legacy verdict for: ' + source);

            const legacyRules = legacyRulesBySource.get(source);
            assert.deepStrictEqual(
                lintSource(source, { optionalChain: false }).errors.map((error) => error.rule),
                legacyRules
            );
            assert.strictEqual(
                validateSyntax(source, { enforceLintOptionalChain: false }).valid,
                legacyRules.length === 0
            );
        });
    }
});
