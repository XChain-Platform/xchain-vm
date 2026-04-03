const assert = require('assert');
const { meterCode, hasGasIdentifier } = require('../src/metering.js');

describe('Metering', function() {

    describe('meterCode', function() {

        it('should inject gas into for loops', function() {
            const code = 'for (var i = 0; i < 10; i++) { x++; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into while loops', function() {
            const code = 'while (x > 0) { x--; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into do-while loops', function() {
            const code = 'do { x--; } while (x > 0);';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into for-in loops', function() {
            const code = 'for (var k in obj) { arr.push(k); }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into for-of loops', function() {
            const code = 'for (var v of arr) { sum += v; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into if statements', function() {
            const code = 'if (x > 0) { y = 1; } else { y = 2; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into switch cases', function() {
            const code = 'switch (x) { case 1: y = 1; break; case 2: y = 2; break; default: y = 0; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into ternary expressions', function() {
            const code = 'var y = x > 0 ? 1 : 2;';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into try/catch/finally', function() {
            const code = 'try { x(); } catch(e) { y(); } finally { z(); }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into function declarations', function() {
            const code = 'function foo() { return 1; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into function expressions', function() {
            const code = 'var foo = function() { return 1; };';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into arrow functions with block body', function() {
            const code = 'var foo = () => { return 1; };';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should inject gas into arrow functions with expression body', function() {
            const code = 'var foo = () => x + 1;';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should handle directive prologue (use strict)', function() {
            const code = 'function foo() { "use strict"; return 1; }';
            const metered = meterCode(code);
            // __gas should be after "use strict", not before
            const strictIdx = metered.indexOf('"use strict"');
            const gasIdx = metered.indexOf('__gas');
            assert(gasIdx > strictIdx, '__gas should come after "use strict"');
        });

        it('should handle nested ternaries', function() {
            const code = 'var y = a ? b ? 1 : 2 : c ? 3 : 4;';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should handle for loop with no update expression', function() {
            const code = 'for (var i = 0; i < 10;) { i++; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should handle call expressions', function() {
            const code = 'foo(); bar(1, 2);';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should produce valid JavaScript output', function() {
            const code = `
                function counter(n) {
                    var count = 0;
                    for (var i = 0; i < n; i++) {
                        if (i % 2 === 0) {
                            count++;
                        } else {
                            count--;
                        }
                    }
                    return count;
                }
            `;
            const metered = meterCode(code);
            // Should parse without error
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should meter module.exports patterns', function() {
            const code = `
                module.exports = {
                    init: function(xchain) {
                        xchain.state.set('x', '1');
                    },
                    run: function(xchain) {
                        var x = xchain.state.get('x');
                        return x;
                    }
                };
            `;
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle class methods', function() {
            const code = `
                class Foo {
                    constructor() { this.x = 1; }
                    bar() { return this.x; }
                }
            `;
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle destructuring in for-of', function() {
            const code = 'for (var [a, b] of items) { sum += a; }';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
        });

        it('should handle optional chaining', function() {
            const code = 'var x = obj?.foo?.bar;';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle nullish coalescing', function() {
            const code = 'var x = a ?? b;';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });
    });

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
    });
});
