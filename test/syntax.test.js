const assert = require('assert');

let validateSyntax, checkFloatWarnings;
try {
    const syntax = require('../src/syntax.js');
    validateSyntax = syntax.validateSyntax;
    checkFloatWarnings = syntax.checkFloatWarnings;
} catch (e) {
    console.log('Skipping syntax tests — isolated-vm not available: ' + e.message);
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
    });
});
