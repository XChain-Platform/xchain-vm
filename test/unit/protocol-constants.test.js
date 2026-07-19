//  doctrine test-coverage program: unit coverage for src/protocol/constants.js.
// The VM's copy of the protocol size/gas/XCALL limits bounds what a contract
// execution and cross-contract call may do; it is a consensus surface kept
// byte-equal with the decoder/indexer copies. This pins the exported constants
// to sane, finite, positive integers and their ordering invariants.

const assert = require('assert');
const C = require('../../src/protocol/constants.js');

describe('protocol/constants', function () {
    const positiveInts = [
        'MAX_ACTION_DATA_LENGTH', 'OP_RETURN_PUSH_OVERHEAD', 'MAX_CODE_SIZE',
        'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MIN_GAS', 'XCALL_MAX_GAS',
        'XCALL_MAX_HOPS', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MAX_DEADLINE_BLOCKS',
        'XCALL_MAX_RETURN_BYTES', 'XCALL_MAX_CALLS_PER_BLOCK',
        'MAX_DEPLOY_CHUNKS', 'MAX_DEPLOYCHUNK_PART_BYTES',
    ];

    for (const name of positiveInts) {
        it(`${name} is a positive safe integer`, function () {
            const v = C[name];
            assert.strictEqual(typeof v, 'number', `${name} must be a number`);
            assert.ok(Number.isSafeInteger(v), `${name} must be a safe integer`);
            assert.ok(v > 0, `${name} must be positive`);
        });
    }

    it('XCALL gas and deadline floors do not exceed their ceilings', function () {
        assert.ok(C.XCALL_MIN_GAS <= C.XCALL_MAX_GAS);
        assert.ok(C.XCALL_MIN_DEADLINE_BLOCKS <= C.XCALL_MAX_DEADLINE_BLOCKS);
    });

    it('the chunked-deploy budget can carry a max-size contract', function () {
        assert.ok(C.MAX_DEPLOY_CHUNKS * C.MAX_DEPLOYCHUNK_PART_BYTES >= C.MAX_CODE_SIZE);
    });

    it('GAS_TICK is the XCHAIN gas symbol', function () {
        assert.strictEqual(C.GAS_TICK, 'XCHAIN');
    });
});
