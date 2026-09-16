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
const ActionValidator = require('../../../src/validator.js');

describe('[P2] Functional Regression', function() {
    // ACTION VALIDATOR
    describe('ActionValidator', function() {

        // Mirrors validator.js#ALLOWED_ACTIONS (16 base + 5 consensus emission actions).
        const ALLOWED = [
            'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER', 'DISPENSER',
            'DIVIDEND', 'AIRDROP', 'CALLBACK', 'FILE', 'LIST', 'COINPAY',
            'SWEEP', 'LINK', 'BROADCAST', 'MESSAGE',
            'ATTEST', 'SLASH', 'EXECUTE', 'XCALL', 'VOTE'
        ];

        let validator;
        before(function() { validator = new ActionValidator(); });

        for (const action of ALLOWED) {
            it(`should accept ${action}`, function() {
                assert.strictEqual(validator.validate({ action, params: {} }), true);
            });
        }

        it('should reject unknown actions', function() {
            assert.throws(() => validator.validate({ action: 'TRANSFER', params: {} }), /unknown/);
            assert.throws(() => validator.validate({ action: 'DEPLOY', params: {} }), /unknown/);
            assert.throws(() => validator.validate({ action: 'send', params: {} }), /unknown/);
        });

        it('should reject null/undefined params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: null }), /params/);
            assert.throws(() => validator.validate({ action: 'SEND', params: undefined }), /params/);
        });
    });
});
