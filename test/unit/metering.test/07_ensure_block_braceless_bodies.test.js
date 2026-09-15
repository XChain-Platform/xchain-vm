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

    // Braceless (single-statement) bodies → ensureBlock
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
});
