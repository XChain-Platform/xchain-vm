// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');

let validateSyntax, checkFloatWarnings;
try {
    const syntax = require('../../src/syntax.js');
    validateSyntax = syntax.validateSyntax;
    checkFloatWarnings = syntax.checkFloatWarnings;
} catch (e) {
    console.log('Skipping syntax tests — isolated-vm not available:', e);
}

(validateSyntax ? describe : describe.skip)('Syntax Validation', function() {

    describe('validateSyntax', function() {
        it('should accept valid code', function() {
            const result = validateSyntax('var x = 1;');
            assert.strictEqual(result.valid, true);
        });

        it('should reject syntax errors', function() {
            const result = validateSyntax('function { invalid }');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('syntax error'), result.error);
        });

        it('should reject __gas identifier', function() {
            const result = validateSyntax('var __gas = 1;');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('__gas'), result.error);
        });

        it('should accept ES2020 features', function() {
            const result = validateSyntax('var x = a?.b ?? "default";');
            assert.strictEqual(result.valid, true);
        });

        it('should accept complex contract code', function() {
            const code = `
                module.exports = {
                    init: function(xchain) {
                        xchain.state.set('x', '1');
                    },
                    run: function(xchain) {
                        var x = xchain.state.get('x');
                        for (var i = 0; i < 10; i++) {
                            x = xchain.math.add(x, '1');
                        }
                        return x;
                    }
                };
            `;
            const result = validateSyntax(code);
            assert.strictEqual(result.valid, true);
        });
    });

    describe('banned transcendental Math.* (blocking)', function() {
        const banned = ['sqrt', 'pow', 'log', 'log2', 'log10'];

        banned.forEach(function(name) {
            it('should reject Math.' + name + ' (dotted form)', function() {
                const result = validateSyntax('var x = Math.' + name + '(2, 3);');
                assert.strictEqual(result.valid, false);
                assert(result.error.includes('Math.' + name), result.error);
                assert(result.error.includes('xchain.math.' + name), result.error);
            });

            it('should reject Math[\'' + name + '\'] (computed form)', function() {
                const result = validateSyntax("var x = Math['" + name + "'](2);");
                assert.strictEqual(result.valid, false);
                assert(result.error.includes('Math.' + name), result.error);
            });
        });

        it('should report the line number of the banned call', function() {
            const result = validateSyntax('var a = 1;\nvar b = Math.sqrt(4);');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('line 2'), result.error);
        });

        it('should still allow retained Math members (floor/abs/min/max)', function() {
            assert.strictEqual(validateSyntax('var x = Math.floor(1.5);').valid, true);
            assert.strictEqual(validateSyntax('var x = Math.abs(-3);').valid, true);
            assert.strictEqual(validateSyntax('var x = Math.max(1, 2);').valid, true);
            assert.strictEqual(validateSyntax('var x = Math.PI;').valid, true);
        });

        it('should not reject a property named like a banned member on another object', function() {
            const result = validateSyntax('var obj = { pow: function(){} }; obj.pow();');
            assert.strictEqual(result.valid, true);
        });

        it('should not reject the string "Math.pow"', function() {
            const result = validateSyntax('var x = "Math.pow";');
            assert.strictEqual(result.valid, true);
        });
    });

    describe('checkFloatWarnings', function() {
        it('should warn on decimal literals', function() {
            const warnings = checkFloatWarnings('var x = 0.1;');
            assert.strictEqual(warnings.length, 1);
            assert(warnings[0].includes('0.1'), warnings[0]);
        });

        it('should not warn on integer literals', function() {
            const warnings = checkFloatWarnings('var x = 42;');
            assert.strictEqual(warnings.length, 0);
        });

        it('should not warn on string decimals', function() {
            const warnings = checkFloatWarnings('var x = "0.1";');
            assert.strictEqual(warnings.length, 0);
        });

        it('should report line numbers', function() {
            const warnings = checkFloatWarnings('var x = 1;\nvar y = 3.14;');
            assert.strictEqual(warnings.length, 1);
            assert(warnings[0].includes('line 2'), warnings[0]);
        });

        it('should report multiple float literals', function() {
            const warnings = checkFloatWarnings('var x = 0.1;\nvar y = 0.2;\nvar z = 0.3;');
            assert.strictEqual(warnings.length, 3);
        });

        it('should handle parse errors gracefully', function() {
            const warnings = checkFloatWarnings('this is { not valid');
            assert.strictEqual(warnings.length, 0);
        });
    });

    describe('validateSyntax (extended)', function() {
        it('should accept empty function body', function() {
            const result = validateSyntax('function foo() {}');
            assert.strictEqual(result.valid, true);
        });

        it('should accept code with only comments', function() {
            const result = validateSyntax('// nothing here');
            assert.strictEqual(result.valid, true);
        });

        it('should reject __gas as function name', function() {
            const result = validateSyntax('function __gas() { return 1; }');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('__gas'));
        });

        it('should reject __gas as variable name in let', function() {
            const result = validateSyntax('let __gas = 42;');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('__gas'));
        });

        it('should accept code using string "__gas"', function() {
            const result = validateSyntax('var x = "__gas";');
            assert.strictEqual(result.valid, true);
        });

        it('should accept arrow functions', function() {
            const result = validateSyntax('var fn = (a, b) => a + b;');
            assert.strictEqual(result.valid, true);
        });

        it('should accept template literals', function() {
            const result = validateSyntax('var x = `hello ${name}`;');
            assert.strictEqual(result.valid, true);
        });

        it('should accept destructuring', function() {
            const result = validateSyntax('var { a, b } = obj;');
            assert.strictEqual(result.valid, true);
        });

        it('should accept for-of loops', function() {
            const result = validateSyntax('for (var x of [1,2,3]) {}');
            assert.strictEqual(result.valid, true);
        });

        it('should reject completely empty string', function() {
            // Empty string is valid JS
            const result = validateSyntax('');
            assert.strictEqual(result.valid, true);
        });
    });
});
