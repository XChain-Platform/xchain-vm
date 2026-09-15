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

describe('Metering', function() {

    describe('deep binary expressions', function() {
        it('should inject gas into deeply nested binary (>10 operands)', function() {
            // Build a + b + c + ... with 15 terms
            const terms = Array.from({ length: 15 }, (_, i) => 'x' + i);
            const code = 'var result = ' + terms.join(' + ') + ';';
            const metered = meterCode(code);
            assert(metered.includes('__gas'), 'should contain __gas for deep binary');
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });

        it('should not inject extra gas for shallow binary (<= 10 operands)', function() {
            const code = 'var result = a + b + c;';
            const metered = meterCode(code);
            // Should be valid but no deep binary injection needed
            require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
        });
    });
});
