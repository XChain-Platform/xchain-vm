const assert = require('assert');
const EmissionCollector = require('../src/collector.js');

describe('EmissionCollector', function() {

    it('should collect emitted actions', function() {
        const ec = new EmissionCollector(50);
        ec.add('SEND', { destination: 'addr', tick: 'T', quantity: '10' });
        assert.strictEqual(ec.getActions().length, 1);
        assert.strictEqual(ec.getActions()[0].action, 'SEND');
    });

    it('should enforce emission limit', function() {
        const ec = new EmissionCollector(3);
        ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        ec.add('SEND', { destination: 'b', tick: 'T', quantity: '1' });
        ec.add('SEND', { destination: 'c', tick: 'T', quantity: '1' });
        assert.throws(() => ec.add('SEND', { destination: 'd', tick: 'T', quantity: '1' }), /emission limit/);
    });

    it('should copy params to prevent mutation', function() {
        const ec = new EmissionCollector(50);
        const params = { destination: 'addr', tick: 'T', quantity: '10' };
        ec.add('SEND', params);
        params.quantity = '999';
        assert.strictEqual(ec.getActions()[0].params.quantity, '10');
    });

    it('should collect logs', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('hello world');
        assert.strictEqual(ec.getLogs().length, 1);
        assert.strictEqual(ec.getLogs()[0], 'hello world');
    });

    it('should cap logs at 100', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 150; i++) {
            ec.addLog('log ' + i);
        }
        assert.strictEqual(ec.getLogs().length, 100);
        assert.strictEqual(ec.isLogFull(), true);
    });

    it('should truncate long log messages', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('x'.repeat(2000));
        assert(ec.getLogs()[0].length <= 1040);  // 1024 + '...(truncated)'
        assert(ec.getLogs()[0].endsWith('...(truncated)'));
    });

    it('should track log count', function() {
        const ec = new EmissionCollector(50);
        assert.strictEqual(ec.getLogCount(), 0);
        ec.addLog('a');
        ec.addLog('b');
        assert.strictEqual(ec.getLogCount(), 2);
    });
});
