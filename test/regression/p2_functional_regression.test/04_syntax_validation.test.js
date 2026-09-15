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
 * [P2] Core Functional Regression Tests
 *
 * Gas metering injection, state operations, all 16 emit types,
 * deterministic math, syntax and action validation.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { validateSyntax, checkFloatWarnings } = require('../../../src/syntax.js');

describe('[P2] Functional Regression', function() {
    // SYNTAX VALIDATION
    describe('Syntax validation', function() {

        it('should accept valid ES2020', function() {
            assert.strictEqual(validateSyntax('var x = a?.b ?? "d";').valid, true);
        });

        it('should reject syntax errors', function() {
            assert.strictEqual(validateSyntax('function { invalid }').valid, false);
        });

        it('should reject __gas identifier', function() {
            assert.strictEqual(validateSyntax('var __gas = 1;').valid, false);
            assert.strictEqual(validateSyntax('function __gas() {}').valid, false);
            assert.strictEqual(validateSyntax('let __gas = 42;').valid, false);
        });

        it('should allow string "__gas"', function() {
            assert.strictEqual(validateSyntax('var x = "__gas";').valid, true);
        });

        it('should detect float warnings', function() {
            assert(checkFloatWarnings('var x = 0.1;').length > 0);
            assert.strictEqual(checkFloatWarnings('var x = 42;').length, 0);
            assert.strictEqual(checkFloatWarnings('var x = "0.1";').length, 0);
        });
    });
});
