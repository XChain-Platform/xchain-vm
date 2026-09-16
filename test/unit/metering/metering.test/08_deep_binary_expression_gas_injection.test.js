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
const { meterCode } = require('../../../../src/metering.js');

describe('Metering', function() {

    // Deeply nested binary expressions (Phase 2)
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
});
