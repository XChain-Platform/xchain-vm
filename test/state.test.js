const assert = require('assert');
const StateManager = require('../src/state.js');

describe('StateManager', function() {

    const LIMITS = {
        maxStateKeys:      10,
        maxStateValueSize: 1024
    };

    it('should read initial state', function() {
        const sm = new StateManager({ foo: 'bar' }, LIMITS);
        assert.strictEqual(sm.get('foo'), 'bar');
    });

    it('should return null for missing keys', function() {
        const sm = new StateManager({}, LIMITS);
        assert.strictEqual(sm.get('missing'), null);
    });

    it('should write and read state', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', 'value');
        assert.strictEqual(sm.get('key'), 'value');
    });

    it('should overwrite existing keys', function() {
        const sm = new StateManager({ x: 'old' }, LIMITS);
        sm.set('x', 'new');
        assert.strictEqual(sm.get('x'), 'new');
    });

    it('should delete keys', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        assert.strictEqual(sm.delete('x'), true);
        assert.strictEqual(sm.get('x'), null);
        assert.strictEqual(sm.has('x'), false);
    });

    it('should return false when deleting non-existent key', function() {
        const sm = new StateManager({}, LIMITS);
        assert.strictEqual(sm.delete('missing'), false);
    });

    it('should handle delete-then-set cycle', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        sm.delete('x');
        sm.set('x', '2');
        assert.strictEqual(sm.get('x'), '2');
        assert.strictEqual(sm.has('x'), true);
    });

    it('should has() return correct values', function() {
        const sm = new StateManager({ x: '1' }, LIMITS);
        assert.strictEqual(sm.has('x'), true);
        assert.strictEqual(sm.has('y'), false);
        sm.set('y', '2');
        assert.strictEqual(sm.has('y'), true);
        sm.delete('x');
        assert.strictEqual(sm.has('x'), false);
    });

    it('should enforce max key count', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 3 });
        sm.set('a', '1');
        sm.set('b', '2');
        sm.set('c', '3');
        assert.throws(() => sm.set('d', '4'), /max state keys/);
    });

    it('should enforce max value size', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 10 });
        assert.throws(() => sm.set('key', 'a'.repeat(100)), /max size/);
    });

    it('should reject null values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', null), /null or undefined/);
    });

    it('should reject undefined values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', undefined), /null or undefined/);
    });

    it('should reject NaN values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', NaN), /NaN or Infinity/);
    });

    it('should reject Infinity values', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('key', Infinity), /NaN or Infinity/);
    });

    it('should allow empty string values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', '');
        assert.strictEqual(sm.get('key'), '');
    });

    it('should collect changes correctly', function() {
        const sm = new StateManager({ existing: 'old' }, LIMITS);
        sm.set('existing', 'new');
        sm.set('added', 'value');
        sm.delete('existing');

        const { changes, deletes } = sm.getChanges();
        // 'existing' was set then deleted — dirty map has null for it
        assert.deepStrictEqual(deletes, ['existing']);
        assert.deepStrictEqual(changes, [{ key: 'added', value: 'value' }]);
    });

    it('should store objects as values', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('obj', { a: 1, b: [2, 3] });
        assert.deepStrictEqual(sm.get('obj'), { a: 1, b: [2, 3] });
    });

    it('should filter null initial state values', function() {
        const sm = new StateManager({ good: 'yes', bad: null, ugly: undefined }, LIMITS);
        assert.strictEqual(sm.get('good'), 'yes');
        assert.strictEqual(sm.get('bad'), null);  // filtered out
        assert.strictEqual(sm.has('bad'), false);
    });

    it('should track key count across delete-set cycles', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 2 });
        sm.set('a', '1');
        sm.set('b', '2');
        // At limit
        assert.throws(() => sm.set('c', '3'), /max state keys/);
        // Delete one, should free a slot
        sm.delete('a');
        sm.set('c', '3');  // should succeed
        assert.strictEqual(sm.get('c'), '3');
    });
});
