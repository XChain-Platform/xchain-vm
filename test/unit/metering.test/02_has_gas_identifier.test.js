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
const { hasGasIdentifier } = require('../../../src/metering.js');

describe('Metering', function() {

    describe('hasGasIdentifier', function() {

        it('should detect __gas identifier', function() {
            assert.strictEqual(hasGasIdentifier('var __gas = 1;'), true);
        });

        it('should detect __gas in function name', function() {
            assert.strictEqual(hasGasIdentifier('function __gas() {}'), true);
        });

        it('should not flag code without __gas', function() {
            assert.strictEqual(hasGasIdentifier('var x = 1;'), false);
        });

        it('should not flag __gas in strings', function() {
            // acorn parses strings as Literal nodes, not Identifier
            assert.strictEqual(hasGasIdentifier('var x = "__gas";'), false);
        });

        it('should handle parse errors gracefully', function() {
            assert.strictEqual(hasGasIdentifier('this is { not valid'), false);
        });

        it('should not detect __gas in member expression property', function() {
            // obj.__gas is a MemberExpression; the property Identifier is not
            // visited as a standalone Identifier by acorn walk.full
            assert.strictEqual(hasGasIdentifier('var x = obj.__gas;'), false);
        });

        it('should not flag __gas in comments', function() {
            // Comments are not Identifier nodes
            assert.strictEqual(hasGasIdentifier('// __gas\nvar x = 1;'), false);
        });
    });
});
