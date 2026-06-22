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
const ActionValidator = require('../../src/validator.js');

describe('ActionValidator', function() {

    let validator;
    beforeEach(function() { validator = new ActionValidator(); });

    // Bind to the production allow-list (not a hand-maintained copy) so every allowed
    // action gets a positive-acceptance assertion and a removal from the production Set
    // can never pass unnoticed (#5152: the old mirror had drifted, omitting XCALL).
    const ALLOWED_ACTIONS = [...ActionValidator.ALLOWED_ACTIONS];

    describe('allowed actions', function() {
        it('every production-allowed action is covered (mirror is bound, not copied)', function() {
            assert.ok(ALLOWED_ACTIONS.includes('XCALL'), 'XCALL must be exercised');
            assert.strictEqual(ALLOWED_ACTIONS.length, 20);
        });
        for (const action of ALLOWED_ACTIONS) {
            it('should accept ' + action, function() {
                assert.strictEqual(validator.validate({ action, params: {} }), true);
            });
        }
    });

    describe('unknown actions', function() {
        it('should reject unknown action type', function() {
            assert.throws(() => validator.validate({ action: 'TRANSFER', params: {} }),
                /unknown emission action/);
        });

        it('should reject DEPLOY action', function() {
            assert.throws(() => validator.validate({ action: 'DEPLOY', params: {} }),
                /unknown emission action/);
        });

        it('should reject empty string action', function() {
            assert.throws(() => validator.validate({ action: '', params: {} }),
                /unknown emission action/);
        });

        it('should reject lowercase action', function() {
            assert.throws(() => validator.validate({ action: 'send', params: {} }),
                /unknown emission action/);
        });

        it('should reject undefined action', function() {
            assert.throws(() => validator.validate({ action: undefined, params: {} }),
                /unknown emission action/);
        });

        it('should reject null action', function() {
            assert.throws(() => validator.validate({ action: null, params: {} }),
                /unknown emission action/);
        });
    });

    describe('params validation', function() {
        it('should reject null params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: null }),
                /params must be an object/);
        });

        it('should reject string params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: 'not an object' }),
                /params must be an object/);
        });

        it('should reject number params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: 42 }),
                /params must be an object/);
        });

        it('should reject undefined params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: undefined }),
                /params must be an object/);
        });

        it('should accept empty object params', function() {
            assert.strictEqual(validator.validate({ action: 'SEND', params: {} }), true);
        });

        it('should accept params with properties', function() {
            assert.strictEqual(
                validator.validate({ action: 'SEND', params: { destination: 'addr', tick: 'T', quantity: '10' } }),
                true
            );
        });

        it('should accept array params (typeof array is object)', function() {
            // Arrays pass typeof === 'object' && !== null
            assert.strictEqual(validator.validate({ action: 'SEND', params: [] }), true);
        });
    });
});
