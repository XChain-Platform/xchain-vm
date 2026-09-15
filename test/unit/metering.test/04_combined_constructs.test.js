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
const { meterCode } = require('../../../src/metering.js');

function registerCombinedFunctionTests() {
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
        // Count __gas occurrences (should be multiple)
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
}

function registerCombinedControlFlowTests() {
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
}

describe('Metering', function() {

    describe('combined constructs', function() {
    registerCombinedFunctionTests();
    registerCombinedControlFlowTests();
    });
});
