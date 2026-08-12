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
 * Chaos Experiment 7: acorn/V8 Parser Divergence
 *
 * Tests JavaScript syntax at acorn's parsing boundary. V8 supports
 * newer syntax than acorn (configured for ecmaVersion 2020). If code
 * passes V8's compileScriptSync but fails meterCode(), the VM returns
 * a metering-failed error. These tests verify that edge-case syntax:
 *
 * 1. Never crashes the VM process
 * 2. Always returns a well-formed result
 * 3. Either succeeds (correct metering) or fails safely
 * 4. Never bypasses gas metering
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { XChainVM, createVM, execute } = require('../helpers/harness');
const { checkResultShape, checkAtomicity, checkGasCeiling } = require('../../fuzz/invariants');

(XChainVM ? describe : describe.skip)('Chaos: Parser Divergence (Exp 7)', function() {

    // Each test case includes name, code, and expected behavior:
    // - expectSuccess: true (must succeed), false (must fail), null (either is fine)
    const PARSER_EDGE_CASES = [
        {
            name: 'arrow function in expression',
            code: `module.exports = function(xchain) {
                var fn = (x) => x + 1;
                return String(fn(41));
            };`,
            expectSuccess: true
        },
        {
            name: 'arrow function with implicit return',
            code: `module.exports = function(xchain) {
                var add = (a, b) => a + b;
                return String(add(1, 2));
            };`,
            expectSuccess: true
        },
        {
            name: 'template literal',
            code: `module.exports = function(xchain) {
                var name = 'world';
                return \`hello \${name}\`;
            };`,
            expectSuccess: true
        },
        {
            name: 'destructuring assignment',
            code: `module.exports = function(xchain) {
                var arr = [1, 2, 3];
                var [a, b, c] = arr;
                return String(a + b + c);
            };`,
            expectSuccess: true
        },
        {
            name: 'destructuring with defaults',
            code: `module.exports = function(xchain) {
                var [a = 10, b = 20] = [1];
                return String(a) + ':' + String(b);
            };`,
            expectSuccess: true
        },
        {
            name: 'object destructuring',
            code: `module.exports = function(xchain) {
                var obj = { x: 1, y: 2 };
                var { x, y } = obj;
                return String(x + y);
            };`,
            expectSuccess: true
        },
        {
            name: 'spread operator',
            code: `module.exports = function(xchain) {
                var a = [1, 2];
                var b = [...a, 3, 4];
                return String(b.length);
            };`,
            expectSuccess: true
        },
        {
            name: 'rest parameters',
            code: `module.exports = function(xchain) {
                function sum(...nums) {
                    var total = 0;
                    for (var i = 0; i < nums.length; i++) total += nums[i];
                    return total;
                }
                return String(sum(1, 2, 3));
            };`,
            expectSuccess: true
        },
        {
            name: 'computed property names',
            code: `module.exports = function(xchain) {
                var key = 'dynamic';
                var obj = { [key]: 'value' };
                return obj.dynamic;
            };`,
            expectSuccess: true
        },
        {
            name: 'for-of loop',
            code: `module.exports = function(xchain) {
                var arr = [1, 2, 3];
                var sum = 0;
                for (var x of arr) sum += x;
                return String(sum);
            };`,
            expectSuccess: true
        },
        {
            name: 'class declaration',
            code: `module.exports = function(xchain) {
                class Counter {
                    constructor(n) { this.n = n; }
                    inc() { this.n++; return this; }
                    val() { return this.n; }
                }
                var c = new Counter(0);
                c.inc().inc().inc();
                return String(c.val());
            };`,
            expectSuccess: true
        },
        {
            name: 'async function (should fail: async is not useful in sync VM)',
            code: `module.exports = async function(xchain) {
                return 'async';
            };`,
            // async returns a Promise, not a value; may fail or return [object Promise]
            expectSuccess: null
        },
        {
            name: 'generator function',
            code: `module.exports = function(xchain) {
                function* gen() { yield 1; yield 2; yield 3; }
                var sum = 0;
                var g = gen();
                var n = g.next();
                while (!n.done) { sum += n.value; n = g.next(); }
                return String(sum);
            };`,
            expectSuccess: true
        },
        {
            name: 'deeply nested ternary',
            code: `module.exports = function(xchain) {
                var x = 5;
                var r = x > 10 ? 'a' : x > 5 ? 'b' : x > 3 ? 'c' : x > 1 ? 'd' : 'e';
                return r;
            };`,
            expectSuccess: true
        },
        {
            name: 'labeled statement with break',
            code: `module.exports = function(xchain) {
                var found = -1;
                outer: for (var i = 0; i < 3; i++) {
                    for (var j = 0; j < 3; j++) {
                        if (i === 1 && j === 1) { found = i * 10 + j; break outer; }
                    }
                }
                return String(found);
            };`,
            expectSuccess: true
        },
        {
            name: 'switch with fall-through',
            code: `module.exports = function(xchain) {
                var x = 2, r = '';
                switch(x) {
                    case 1: r += 'a';
                    case 2: r += 'b';
                    case 3: r += 'c'; break;
                    default: r += 'd';
                }
                return r;
            };`,
            expectSuccess: true
        },
        {
            name: 'try-catch-finally',
            code: `module.exports = function(xchain) {
                var r = '';
                try {
                    r += 'try;';
                    throw new Error('test');
                } catch(e) {
                    r += 'catch;';
                } finally {
                    r += 'finally';
                }
                return r;
            };`,
            expectSuccess: true
        },
        {
            name: 'deeply nested binary expression (metering injection at depth > 10)',
            code: `module.exports = function(xchain) {
                var a = 1;
                var r = a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a;
                return String(r);
            };`,
            expectSuccess: true
        },
    ];

    for (const tc of PARSER_EDGE_CASES) {
        it('CHAOS-7xx: ' + tc.name, async function() {
            this.timeout(10000);
            const vm = createVM({ gasCeiling: 100000 });
            const result = await execute(vm, tc.code);

            // Must always return a valid result shape; never crash
            checkResultShape(result);

            if (tc.expectSuccess === true) {
                assert.strictEqual(result.success, true,
                    'Expected success for "' + tc.name + '": ' + result.error);
            } else if (tc.expectSuccess === false) {
                assert.strictEqual(result.success, false,
                    'Expected failure for "' + tc.name + '"');
            }
            // expectSuccess === null: just verify shape and no crash

            // If failed, verify atomicity
            if (!result.success) {
                checkAtomicity(result);
            }

            // Gas ceiling should never be exceeded
            checkGasCeiling(result, 100000);
        });
    }

    it('CHAOS-710: gas is charged for complex syntax constructs', async function() {
        this.timeout(10000);
        const vm = createVM({ gasCeiling: 100000 });

        // Code with many metering injection points
        const code = `module.exports = function(xchain) {
            var sum = 0;
            for (var i = 0; i < 100; i++) {
                if (i % 2 === 0) {
                    sum += i;
                } else {
                    sum -= 1;
                }
                try {
                    var x = i > 50 ? i * 2 : i * 3;
                    sum += x;
                } catch(e) {}
            }
            return String(sum);
        };`;

        const result = await execute(vm, code);
        assert.strictEqual(result.success, true, 'Complex code should succeed: ' + result.error);
        // Gas should be substantial (many injection points)
        assert(result.gasUsed > 100,
            'Complex code should charge significant gas, got: ' + result.gasUsed);
    });

    it('CHAOS-711: metered code produces same result as intended', async function() {
        this.timeout(10000);
        const vm = createVM();

        // Fibonacci: verifies metering doesn't alter loop semantics
        const code = `module.exports = function(xchain) {
            var a = 0, b = 1;
            for (var i = 0; i < 20; i++) {
                var temp = b;
                b = a + b;
                a = temp;
            }
            return String(a);
        };`;

        const result = await execute(vm, code);
        assert.strictEqual(result.success, true);
        // Fibonacci(20) = 6765
        assert.strictEqual(JSON.parse(result.returnValue), '6765',
            'Metering should not alter computation result');
    });
});
