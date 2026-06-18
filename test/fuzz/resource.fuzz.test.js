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
 * Fuzz Tests: Resource Exhaustion
 *
 * Tests that resource limits (gas, memory, timeout) cannot be
 * bypassed and that exhaustion is handled gracefully.
 ********************************************************************/
// @ts-nocheck

// 


const fc = require('fast-check');
const assert = require('assert');
const { XChainVM, createVM, execute, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkAtomicity, checkGasCeiling, checkNoPrototypePollution } = require('./invariants');
const { anyCodeArb } = require('./generators/code');

const METERING_BYPASS_ATTEMPTS = [
    // Override __gas inside contract
    'module.exports = function(xchain) { var __gas = function(){}; while(true){} };',
    'module.exports = function(xchain) { globalThis.__gas = function(){}; while(true){} };',

    // Try to redefine __gas on global
    'module.exports = function(xchain) { try { Object.defineProperty(globalThis, "__gas", { value: function(){} }); } catch(e){} while(true){} };',

    // Expression-heavy code (no control flow; tests that metering covers expressions)
    'module.exports = function(xchain) { var a = 1; ' + 'a = a + a; '.repeat(500) + ' return a; };',

    // String concatenation bomb
    'module.exports = function(xchain) { var s = "x"; ' + 's = s + s; '.repeat(30) + ' return s.length; };',

    // Array growth
    'module.exports = function(xchain) { var a = []; for(var i=0; i<100000; i++) a.push(i); return a.length; };',

    // Deep recursion
    'module.exports = function(xchain) { function r(n) { if(n<=0) return 0; return r(n-1)+1; } return r(10000); };',

    // Mutual recursion
    'module.exports = function(xchain) { function a(n){return n<=0?0:b(n-1);} function b(n){return n<=0?0:a(n-1);} return a(10000); };',

    // try/catch infinite loop
    'module.exports = function(xchain) { while(true) { try { throw 1; } catch(e) {} } };',

    // Generator-like pattern with repeated yield-like calls
    'module.exports = function(xchain) { var i=0; while(true){ i++; if(i>1e9) break; } return i; };',

    // Nested loops
    'module.exports = function(xchain) { for(var i=0;i<1000;i++) for(var j=0;j<1000;j++){} return "done"; };',

    // RegExp backtracking (if RegExp is available)
    'module.exports = function(xchain) { try { var re = /^(a+)+$/; re.test("a".repeat(30) + "b"); } catch(e){} return "done"; };',
];

const MEMORY_EXHAUSTION_ATTEMPTS = [
    // Array allocation bomb
    'module.exports = function(xchain) { try { var a = new Array(10000000); a.fill(0); } catch(e){} return "done"; };',

    // String doubling
    'module.exports = function(xchain) { var s = "x"; try { for(var i=0;i<40;i++) s = s + s; } catch(e){} return s.length; };',

    // Object creation flood
    'module.exports = function(xchain) { var arr = []; try { for(var i=0;i<1000000;i++) arr.push({a:i,b:i*2,c:"str"+i}); } catch(e){} return arr.length; };',

    // Nested object creation
    'module.exports = function(xchain) { var o = {}; try { for(var i=0;i<100;i++) o = {parent:o,data:"x".repeat(10000)}; } catch(e){} return "done"; };',
];

(XChainVM ? describe : describe.skip)('Fuzz: Resource Exhaustion', function() {
    this.timeout(120000);

    it('low gas ceiling terminates within wall-clock time', async function() {
        const tightVM = createVM({ gasCeiling: 100 });
        await fc.assert(fc.asyncProperty(anyCodeArb, async (code) => {
            const start = Date.now();
            const result = await execute(tightVM, code);
            const elapsed = Date.now() - start;
            checkResultShape(result);
            checkAtomicity(result);
            // Should terminate quickly with tight gas ceiling
            assert(elapsed < 5000,
                'Execution took too long (' + elapsed + 'ms) with gas ceiling 100');
        }), FC_OPTIONS);
    });

    it('very low gas ceiling produces out_of_gas on non-trivial contracts', async function() {
        const lowVM = createVM({ gasCeiling: 10 });
        // A looping contract must exhaust this low ceiling
        const code = 'module.exports = function(xchain) { for(var i=0;i<100;i++){} return i; };';
        const result = await execute(lowVM, code);
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Should fail with gas ceiling 10');
        assert(result.error.includes('out_of_gas') || result.error.includes('gas'),
            'Error should mention gas: ' + result.error);
    });

    describe('metering bypass attempts', function() {
        let tightVM;
        before(function() { tightVM = createVM({ gasCeiling: 5000 }); });

        for (let i = 0; i < METERING_BYPASS_ATTEMPTS.length; i++) {
            it('bypass attempt #' + (i + 1) + ' is caught', async function() {
                const code = METERING_BYPASS_ATTEMPTS[i];
                const start = Date.now();
                const result = await execute(tightVM, code);
                const elapsed = Date.now() - start;
                checkResultShape(result);
                checkAtomicity(result);
                // Must terminate (not hang). Covered by mocha timeout, but also check wall-clock
                assert(elapsed < 10000, 'Bypass attempt hung for ' + elapsed + 'ms');
                // Gas used should not wildly exceed ceiling
                checkGasCeiling(result, 5000);
            });
        }
    });

    describe('memory exhaustion attempts', function() {
        let smallMemVM;
        before(function() { smallMemVM = createVM({ maxMemory: 8 }); });

        for (let i = 0; i < MEMORY_EXHAUSTION_ATTEMPTS.length; i++) {
            it('memory bomb #' + (i + 1) + ' terminates gracefully', async function() {
                const code = MEMORY_EXHAUSTION_ATTEMPTS[i];
                const result = await execute(smallMemVM, code);
                checkResultShape(result);
                checkAtomicity(result);
                checkNoPrototypePollution();
            });
        }
    });

    it('deep recursion is caught', async function() {
        const vm = createVM({ gasCeiling: 50000 });
        const code = 'module.exports = function(xchain) { function r(n){return r(n+1);} return r(0); };';
        const result = await execute(vm, code);
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Infinite recursion should fail');
        checkAtomicity(result);
    });

    it('return values exceeding 65536 bytes are truncated', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { return "x".repeat(100000); };';
        const result = await execute(vm, code);
        checkResultShape(result);
        if (result.success && result.returnValue !== null) {
            assert(result.returnValue.length <= 65536 + 2, // +2 for JSON quotes
                'Return value not truncated: ' + result.returnValue.length + ' bytes');
        }
    });

    it('compilation bomb (deeply nested expressions) terminates', async function() {
        const vm = createVM({ gasCeiling: 10000 });
        // Build a deeply nested expression
        let expr = '1';
        for (let i = 0; i < 50; i++) expr = '(' + expr + ' + 1)';
        const code = 'module.exports = function(xchain) { return ' + expr + '; };';
        const start = Date.now();
        const result = await execute(vm, code);
        const elapsed = Date.now() - start;
        checkResultShape(result);
        assert(elapsed < 10000, 'Compilation bomb took ' + elapsed + 'ms');
    });

    it('try/catch loop exhausts gas, does not run forever', async function() {
        const vm = createVM({ gasCeiling: 5000 });
        const code = 'module.exports = function(xchain) { while(true){ try{throw 1;}catch(e){} } };';
        const start = Date.now();
        const result = await execute(vm, code);
        const elapsed = Date.now() - start;
        checkResultShape(result);
        assert.strictEqual(result.success, false);
        assert(elapsed < 5000, 'try/catch loop took ' + elapsed + 'ms');
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
