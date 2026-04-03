const assert = require('assert');
const ActionValidator = require('../src/validator.js');

describe('ActionValidator', function() {

    let validator;
    beforeEach(function() { validator = new ActionValidator(); });

    const ALLOWED_ACTIONS = [
        'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER',
        'DISPENSER', 'DIVIDEND', 'AIRDROP', 'CALLBACK',
        'FILE', 'LIST', 'COINPAY', 'SWEEP', 'LINK', 'BROADCAST', 'MESSAGE'
    ];

    describe('allowed actions', function() {
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

        it('should reject EXECUTE action', function() {
            assert.throws(() => validator.validate({ action: 'EXECUTE', params: {} }),
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
