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
 * [P2] Core Functional Regression Tests
 *
 * Gas metering injection, state operations, all 16 emit types,
 * deterministic math, syntax and action validation.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { GasExhaustedError, ContractRevertError } = require('../../../src/errors.js');

describe('[P2] Functional Regression', function() {
    // ERROR CLASSES
    describe('Error classes', function() {

        it('should construct ContractRevertError with reason', function() {
            const e = new ContractRevertError('test reason');
            assert(e instanceof Error);
            assert(e instanceof ContractRevertError);
            assert(e.message.includes('test reason'));
        });

        it('should construct GasExhaustedError with used/ceiling', function() {
            const e = new GasExhaustedError(150, 100);
            assert(e instanceof Error);
            assert(e instanceof GasExhaustedError);
            assert.strictEqual(e.used, 150);
            assert.strictEqual(e.ceiling, 100);
        });
    });
});
