const assert = require('assert');
const { buildEmitAPI } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const EmissionCollector = require('../../src/collector.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
};

function createEmitAPI() {
    const gasTracker = new GasTracker(SCHEDULE, 1000000);
    const collector = new EmissionCollector(50);
    const emit = buildEmitAPI(gasTracker, collector, SCHEDULE);
    return { emit, gasTracker, collector };
}

describe('Emit API', function() {

    describe('send', function() {
        it('should queue SEND with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.send({ destination: 'addr2', tick: 'TEST', quantity: '100' });
            const actions = collector.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].action, 'SEND');
            assert.strictEqual(actions[0].params.destination, 'addr2');
            assert.strictEqual(actions[0].params.tick, 'TEST');
            assert.strictEqual(actions[0].params.quantity, '100');
        });

        it('should fail on missing destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ tick: 'T', quantity: '1' }), /destination/);
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ destination: 'a', quantity: '1' }), /tick/);
        });

        it('should fail on missing quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send({ destination: 'a', tick: 'T' }), /quantity/);
        });
    });

    describe('destroy', function() {
        it('should queue DESTROY with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.destroy({ tick: 'TEST', quantity: '50' });
            assert.strictEqual(collector.getActions()[0].action, 'DESTROY');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.destroy({ quantity: '1' }), /tick/);
        });

        it('should fail on missing quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.destroy({ tick: 'T' }), /quantity/);
        });
    });

    describe('issue', function() {
        it('should queue ISSUE with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.issue({ tick: 'NEW' });
            assert.strictEqual(collector.getActions()[0].action, 'ISSUE');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.issue({}), /tick/);
        });
    });

    describe('mint', function() {
        it('should queue MINT with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.mint({ tick: 'TEST', quantity: '1000' });
            assert.strictEqual(collector.getActions()[0].action, 'MINT');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.mint({ quantity: '1' }), /tick/);
        });

        it('should fail on missing quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.mint({ tick: 'T' }), /quantity/);
        });
    });

    describe('order', function() {
        it('should queue ORDER with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.order({ giveAmount: '100', getAmount: '50' });
            assert.strictEqual(collector.getActions()[0].action, 'ORDER');
        });

        it('should fail on missing giveAmount', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.order({ getAmount: '50' }), /giveAmount/);
        });

        it('should fail on missing getAmount', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.order({ giveAmount: '100' }), /getAmount/);
        });
    });

    describe('dispenser', function() {
        it('should queue DISPENSER with any params', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser({ tick: 'T', rate: '1' });
            assert.strictEqual(collector.getActions()[0].action, 'DISPENSER');
        });

        it('should accept empty object params', function() {
            const { emit, collector } = createEmitAPI();
            emit.dispenser({});
            assert.strictEqual(collector.getActions()[0].action, 'DISPENSER');
        });
    });

    describe('dividend', function() {
        it('should queue DIVIDEND with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.dividend({ tick: 'T', dividendTick: 'DT', quantity: '100' });
            assert.strictEqual(collector.getActions()[0].action, 'DIVIDEND');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ dividendTick: 'DT', quantity: '1' }), /tick/);
        });

        it('should fail on missing dividendTick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ tick: 'T', quantity: '1' }), /dividendTick/);
        });

        it('should fail on missing quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.dividend({ tick: 'T', dividendTick: 'DT' }), /quantity/);
        });
    });

    describe('airdrop', function() {
        it('should queue AIRDROP with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.airdrop({ tick: 'T', quantity: '10', listActionIndex: 5 });
            assert.strictEqual(collector.getActions()[0].action, 'AIRDROP');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.airdrop({ quantity: '1', listActionIndex: 5 }), /tick/);
        });

        it('should fail on missing quantity', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.airdrop({ tick: 'T', listActionIndex: 5 }), /quantity/);
        });

        it('should fail on missing listActionIndex', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.airdrop({ tick: 'T', quantity: '10' }), /listActionIndex/);
        });
    });

    describe('callback', function() {
        it('should queue CALLBACK with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.callback({ tick: 'T' });
            assert.strictEqual(collector.getActions()[0].action, 'CALLBACK');
        });

        it('should fail on missing tick', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.callback({}), /tick/);
        });
    });

    describe('file', function() {
        it('should queue FILE with any params', function() {
            const { emit, collector } = createEmitAPI();
            emit.file({ data: 'content' });
            assert.strictEqual(collector.getActions()[0].action, 'FILE');
        });

        it('should accept empty object params', function() {
            const { emit, collector } = createEmitAPI();
            emit.file({});
            assert.strictEqual(collector.getActions()[0].action, 'FILE');
        });
    });

    describe('list', function() {
        it('should queue LIST with any params', function() {
            const { emit, collector } = createEmitAPI();
            emit.list({ items: ['a', 'b'] });
            assert.strictEqual(collector.getActions()[0].action, 'LIST');
        });
    });

    describe('coinpay', function() {
        it('should queue COINPAY with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.coinpay({ orderMatchActionIndex: 42 });
            assert.strictEqual(collector.getActions()[0].action, 'COINPAY');
        });

        it('should fail on missing orderMatchActionIndex', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.coinpay({}), /orderMatchActionIndex/);
        });
    });

    describe('sweep', function() {
        it('should queue SWEEP with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.sweep({ destination: 'addr' });
            assert.strictEqual(collector.getActions()[0].action, 'SWEEP');
        });

        it('should fail on missing destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.sweep({}), /destination/);
        });
    });

    describe('link', function() {
        it('should queue LINK with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.link({ coin1: 'BTC', coin1ActionIndex: 1, coin2: 'DOGE', coin2ActionIndex: 2 });
            assert.strictEqual(collector.getActions()[0].action, 'LINK');
        });

        it('should fail on missing coin1', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }), /coin1/);
        });

        it('should fail on missing coin1ActionIndex', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1: 'B', coin2: 'D', coin2ActionIndex: 2 }), /coin1ActionIndex/);
        });

        it('should fail on missing coin2', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1: 'B', coin1ActionIndex: 1, coin2ActionIndex: 2 }), /coin2/);
        });

        it('should fail on missing coin2ActionIndex', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.link({ coin1: 'B', coin1ActionIndex: 1, coin2: 'D' }), /coin2ActionIndex/);
        });
    });

    describe('broadcast', function() {
        it('should queue BROADCAST with any params', function() {
            const { emit, collector } = createEmitAPI();
            emit.broadcast({ data: 'msg' });
            assert.strictEqual(collector.getActions()[0].action, 'BROADCAST');
        });
    });

    describe('message', function() {
        it('should queue MESSAGE with valid params', function() {
            const { emit, collector } = createEmitAPI();
            emit.message({ destination: 'addr', body: 'hello' });
            assert.strictEqual(collector.getActions()[0].action, 'MESSAGE');
        });

        it('should fail on missing destination', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.message({ body: 'hello' }), /destination/);
        });
    });

    describe('gas charging', function() {
        it('should charge VM_EMISSION gas per emit call', function() {
            const { emit, gasTracker } = createEmitAPI();
            emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            assert.strictEqual(gasTracker.getUsed(), SCHEDULE.VM_EMISSION);
        });

        it('should charge gas cumulatively across emit calls', function() {
            const { emit, gasTracker } = createEmitAPI();
            emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            emit.destroy({ tick: 'T', quantity: '1' });
            emit.issue({ tick: 'NEW' });
            assert.strictEqual(gasTracker.getUsed(), SCHEDULE.VM_EMISSION * 3);
        });

        it('should charge gas even when validation fails', function() {
            const { emit, gasTracker } = createEmitAPI();
            // send charges gas before validateRequired
            try {
                emit.send({ tick: 'T', quantity: '1' }); // missing destination
            } catch (e) {}
            assert.strictEqual(gasTracker.getUsed(), SCHEDULE.VM_EMISSION);
        });
    });

    describe('params handling', function() {
        it('should reject non-object params', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send('not an object'), /params must be an object/);
        });

        it('should reject null params', function() {
            const { emit } = createEmitAPI();
            assert.throws(() => emit.send(null), /params must be an object/);
        });

        it('should preserve extra fields beyond required', function() {
            const { emit, collector } = createEmitAPI();
            emit.send({ destination: 'a', tick: 'T', quantity: '1', memo: 'extra' });
            assert.strictEqual(collector.getActions()[0].params.memo, 'extra');
        });

        it('should deep copy params on queue', function() {
            const { emit, collector } = createEmitAPI();
            const params = { destination: 'a', tick: 'T', quantity: '1' };
            emit.send(params);
            params.quantity = '999';
            assert.strictEqual(collector.getActions()[0].params.quantity, '1');
        });
    });
});
