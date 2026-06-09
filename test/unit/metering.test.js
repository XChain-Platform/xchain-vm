// @ts-nocheck
// 
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
const { meterCode, hasGasIdentifier } = require('../../src/metering.js');
const GasTracker = require('../../src/gas.js');

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

        it('should inject gas at the top-level script entry point', function() {
            // Pure top-level declaration with no calls — must still be charged
            const code = 'const lookup = { a: 1, b: 2, c: 3 };';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas calls');
            // The entry-point gas charge must precede the declaration it guards
            const gasIdx = metered.indexOf('__gas');
            const declIdx = metered.indexOf('lookup');
            assert(gasIdx !== -1 && gasIdx < declIdx,
                '__gas should come before the top-level declaration');
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should inject top-level gas after a script directive prologue', function() {
            const code = '"use strict";\nvar x = 1;';
            const metered = meterCode(code);
            const strictIdx = metered.indexOf('"use strict"');
            const gasIdx = metered.indexOf('__gas');
            assert(gasIdx > strictIdx,
                'top-level __gas should come after the "use strict" directive');
        });

        it('should handle directive prologue (use strict)', function() {
            const code = 'function foo() { "use strict"; return 1; }';
            const metered = meterCode(code);
            // The function-body __gas should be after "use strict", not before.
            // (A top-level entry-point __gas precedes the whole script, so search
            // for the gas charge that follows the directive.)
            const strictIdx = metered.indexOf('"use strict"');
            const gasIdx = metered.indexOf('__gas', strictIdx);
            assert(gasIdx > strictIdx, 'function-body __gas should come after "use strict"');
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

        it('should not detect __gas in member expression property', function() {
            // obj.__gas is a MemberExpression — the property Identifier is not
            // visited as a standalone Identifier by acorn walk.full
            assert.strictEqual(hasGasIdentifier('var x = obj.__gas;'), false);
        });

        it('should not flag __gas in comments', function() {
            // Comments are not Identifier nodes
            assert.strictEqual(hasGasIdentifier('// __gas\nvar x = 1;'), false);
        });
    });

    describe('deep binary expressions', function() {
        it('should inject gas into deeply nested binary (>10 operands)', function() {
            // Build a + b + c + ... with 15 terms
            const terms = Array.from({ length: 15 }, (_, i) => 'x' + i);
            const code = 'var result = ' + terms.join(' + ') + ';';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas for deep binary');
            // Should still produce valid JS
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should not inject extra gas for shallow binary (<= 10 operands)', function() {
            const code = 'var result = a + b + c;';
            const metered = meterCode(code);
            // Should be valid but no deep binary injection needed
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });
    });

    describe('combined constructs', function() {
        it('should meter code with loops, ternaries, calls, and functions', function() {
            const code = `
                function process(items) {
                    var result = [];
                    for (var i = 0; i < items.length; i++) {
                        var val = items[i] > 0 ? items[i] * 2 : 0;
                        result.push(val);
                    }
                    return result;
                }
            `;
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
            // Count __gas occurrences — should be multiple
            const gasCount = (metered.match(/__gas/g) || []).length;
            assert(gasCount >= 4, 'should have multiple __gas injection points, got ' + gasCount);
        });

        it('should handle arrow with destructured params', function() {
            const code = 'var fn = ({ a, b }) => a + b;';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle arrow with default params', function() {
            const code = 'var fn = (a = 1, b = 2) => { return a + b; };';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle arrow with rest params', function() {
            const code = 'var fn = (...args) => args.length;';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle multiple directive prologues', function() {
            const code = 'function foo() { "use strict"; "use asm"; return 1; }';
            const metered = meterCode(code);
            const asmIdx = metered.indexOf('"use asm"');
            const gasIdx = metered.indexOf('__gas', asmIdx);
            assert(gasIdx > asmIdx, 'function-body __gas should come after all directives');
        });

        it('should handle else-if chains', function() {
            const code = 'if (a) { x(); } else if (b) { y(); } else if (c) { z(); } else { w(); }';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle empty switch case', function() {
            const code = 'switch (x) { case 1: case 2: y = 1; break; }';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should handle try without catch', function() {
            const code = 'try { x(); } finally { y(); }';
            const metered = meterCode(code);
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });
    });

    describe('per-iteration gas cost (regression pin)', function() {
        // A complete gas schedule (mirrors the unit suites). chargeComputation()
        // charges VM_COMPUTATION on every injected __gas() call.
        const SCHEDULE = {
            VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
            VM_STATE_DELETE: 200, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
            VM_ATTEST_REQUEST: 100, VM_EMISSION: 100
        };
        const VM_COMPUTATION = SCHEDULE.VM_COMPUTATION;

        // Meter `src`, run it with a __gas stub that mirrors src/index.js
        // (every injected __gas() => gasTracker.chargeComputation()), and return
        // the total gas charged. No isolated-vm needed — meterCode output is plain
        // JS and the charge semantics are identical.
        function gasUsedFor(src) {
            const metered = meterCode(src);
            const tracker = new GasTracker({ ...SCHEDULE }, Number.MAX_SAFE_INTEGER);
            const run = new Function('__gas', metered);
            run(() => tracker.chargeComputation());
            return tracker.getUsed();
        }

        // Empty program meters to a single top-level entry-point __gas charge.
        // Subtracting it isolates the gas attributable purely to the loop.
        const baseline = gasUsedFor('');

        it('ForStatement charges 2x VM_COMPUTATION per iteration (body + update)', function() {
            const N = 5;
            // The metering transform injects __gas(1) twice per for-iteration:
            //   - once at the top of the loop body, and
            //   - once into the update expression: for (;;i++) => for (;;(__gas(1), i++))
            // so a for-loop's per-iteration cost is 2 x VM_COMPUTATION, not 1x.
            const used = gasUsedFor('for (var i = 0; i < ' + N + '; i++) {}') - baseline;
            assert.strictEqual(used, 2 * N * VM_COMPUTATION,
                'for-loop of ' + N + ' iterations should charge 2N x VM_COMPUTATION (body + update)');
        });

        it('a for-loop with no update expression still charges 2x per iteration', function() {
            const N = 5;
            // Even `for (;;)` with no author-written update gets a synthesized
            // __gas(1) in the update slot, so the 2x charge is unconditional.
            const used = gasUsedFor('for (var i = 0; i < ' + N + ';) { i++; }') - baseline;
            assert.strictEqual(used, 2 * N * VM_COMPUTATION,
                'for-loop without an update expression should still charge 2N x VM_COMPUTATION');
        });

        it('WhileStatement charges only 1x VM_COMPUTATION per iteration (no update slot)', function() {
            const N = 5;
            // Contrast: while/do-while have no update expression, so they charge
            // 1x VM_COMPUTATION per iteration — the asymmetry the for-loop test pins.
            const used = gasUsedFor('var i = 0; while (i < ' + N + ') { i++; }') - baseline;
            assert.strictEqual(used, N * VM_COMPUTATION,
                'while-loop of ' + N + ' iterations should charge N x VM_COMPUTATION');
        });
    });

    // ─── Allocator transforms (Phase 0) ──────────────────────────────────
    // transformAllocators rewrites syntax-level allocators into metered helper
    // calls before gas injection. Each construct emits a distinct helper marker.
    describe('allocator transforms', function() {

        it('rewrites a plain tagged template to __tmpltag', function() {
            const metered = meterCode('var s = tag`hello ${name} world`;');
            assert(metered.includes('__tmpltag('), 'plain tag → __tmpltag');
        });

        it('rewrites a member tagged template to __tmpltagm', function() {
            const metered = meterCode('var s = String.raw`a${b}c`;');
            assert(metered.includes('__tmpltagm('), 'member tag → __tmpltagm');
        });

        it('handles a tagged template with an invalid cooked escape (cooked == null)', function() {
            // \\unicode is an invalid escape; cooked is null in a tagged template → void 0.
            const metered = meterCode('var s = tag`\\unicode`;');
            assert(metered.includes('__tmpltag('), 'still rewrites; cooked null path exercised');
        });

        it('rewrites an untagged template literal to __tmpl', function() {
            const metered = meterCode('var s = `q0${e0}q1${e1}q2`;');
            assert(metered.includes('__tmpl('), 'template literal → __tmpl');
        });

        it('rewrites array spread to __arrspread', function() {
            const metered = meterCode('var a = [x, ...rest, y];');
            assert(metered.includes('__arrspread('), 'array spread → __arrspread');
        });

        it('skips array spread when the array has holes', function() {
            const metered = meterCode('var a = [x, , ...rest];');
            assert(!metered.includes('__arrspread('), 'holes → left untransformed');
        });

        it('rewrites object spread to __objspread', function() {
            const metered = meterCode('var o = {...base, k: v, [c]: d};');
            assert(metered.includes('__objspread('), 'object spread → __objspread');
        });

        it('skips object spread when combined with a method/accessor', function() {
            const metered = meterCode('var o = {...base, m() { return 1; }};');
            assert(!metered.includes('__objspread('), 'method + spread → left untransformed');
        });

        it('rewrites a member += concat to __setconcat', function() {
            const metered = meterCode('obj.prop += "x";');
            assert(metered.includes('__setconcat('), 'member concat-assign → __setconcat');
        });

        it('rewrites a computed-member += concat to __setconcat', function() {
            // obj[k] += "x" — computed member key path of _memberKey.
            const metered = meterCode('obj[k] += "x";');
            assert(metered.includes('__setconcat('), 'computed member concat-assign → __setconcat');
        });

        it('rewrites object spread with a string-literal key', function() {
            // non-computed Literal key → _lit(p.key.value) branch.
            const metered = meterCode('var o = {...base, "strkey": v};');
            assert(metered.includes('__objspread('), 'string-literal key handled');
        });
    });

    // ─── Braceless (single-statement) bodies → ensureBlock ────────────────
    describe('ensureBlock (braceless bodies)', function() {

        it('wraps a braceless if/else body and injects gas', function() {
            const metered = meterCode('if (x) y = 1; else y = 2;');
            assert(metered.includes('{'), 'braceless consequent/alternate wrapped in a block');
            assert(metered.includes('__gas'));
        });

        it('wraps a braceless for-loop body', function() {
            const metered = meterCode('for (var i = 0; i < 3; i++) x++;');
            assert(metered.includes('__gas'));
        });

        it('wraps a braceless while-loop body', function() {
            const metered = meterCode('while (x) x--;');
            assert(metered.includes('__gas'));
        });
    });

    // ─── Deeply nested binary expressions (Phase 2) ───────────────────────
    // NB: '+' is rewritten to __concat in Phase 0, so a deep '+' chain leaves no
    // BinaryExpression nodes. Use '*' (not an allocator op) to keep them binary.
    describe('deep binary-expression gas injection', function() {

        it('injects gas into a binary chain deeper than 10 (* operator)', function() {
            const expr = Array.from({ length: 13 }, (_, i) => 'a' + i).join(' * ');
            const metered = meterCode('var z = ' + expr + ';');
            assert(metered.includes('__gas'), 'deep chain instrumented without throwing');
        });

        it('leaves a shallow binary chain to the normal path', function() {
            const metered = meterCode('var z = a * b * c;');
            assert(typeof metered === 'string' && metered.length > 0);
        });
    });

    // ─── Call-as-argument: Phase 3 replaces a node held in a parent array ──
    it('wraps a nested call that sits in its parent call\'s argument array', function() {
        // inner() is an element of outer()'s `arguments` array → the array-index
        // replacement branch of the Phase 3 call wrapper.
        const metered = meterCode('var r = outer(inner());');
        assert(metered.includes('__gas'), 'both calls instrumented');
    });
});
