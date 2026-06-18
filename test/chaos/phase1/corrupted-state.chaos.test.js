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
 * Chaos Experiment 6: Corrupted State Input
 *
 * Feeds various corrupted opts.state objects into the VM and verifies
 * no crashes, correct error handling, and no prototype pollution on
 * the host process. Tests the StateManager's resilience to adversarial
 * initial state.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { XChainVM, createVM, execute, chaosAssertions } = require('../helpers/harness');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('../../fuzz/invariants');

// Helper to build a deeply nested object
function buildDeepObject(depth) {
    let obj = { leaf: 'value' };
    for (let i = 0; i < depth; i++) {
        obj = { nested: obj };
    }
    return obj;
}

(XChainVM ? describe : describe.skip)('Chaos: Corrupted State Input (Exp 6)', function() {

    // Simple contract that reads and writes state
    const readerCode = `module.exports = function(xchain) {
        var keys = [];
        // Try to read known keys
        var v1 = xchain.state.get('test_key');
        if (v1 !== null) keys.push('test_key:' + JSON.stringify(v1));
        xchain.state.set('new_key', 'new_value');
        return keys.join(',');
    };`;

    it('CHAOS-601: null bytes in state keys', async function() {
        const vm = createVM();
        const state = { 'key\x00evil': 'value', 'normal': 'ok' };
        const result = await execute(vm, readerCode, { state });
        checkResultShape(result);
        checkNoPrototypePollution();
        // Should not crash; null bytes in keys are valid strings
    });

    it('CHAOS-602: Unicode RTL override in state keys', async function() {
        const vm = createVM();
        const state = { '\u202E\u202Akey': 'value', '\uFEFF': 'bom' };
        const result = await execute(vm, readerCode, { state });
        checkResultShape(result);
        checkNoPrototypePollution();
    });

    it('CHAOS-603: __proto__ key does not pollute prototype', async function() {
        const vm = createVM();
        // StateManager uses Object.create(null) which makes __proto__ safe
        const state = { '__proto__': { isAdmin: true }, 'constructor': 'injected' };

        const code = `module.exports = function(xchain) {
            var proto = xchain.state.get('__proto__');
            var ctor = xchain.state.get('constructor');
            xchain.log('proto type: ' + typeof proto);
            xchain.log('ctor: ' + String(ctor));
            return { proto: typeof proto, ctor: String(ctor) };
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        checkNoPrototypePollution();

        // Verify host Object.prototype is not polluted
        assert.strictEqual(({}).isAdmin, undefined, 'Object.prototype should not be polluted');
    });

    it('CHAOS-604: deeply nested state value (100 levels)', async function() {
        const vm = createVM();
        const deep = buildDeepObject(100);
        const state = { 'deep': deep };

        const code = `module.exports = function(xchain) {
            var val = xchain.state.get('deep');
            return typeof val;
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        // Deep objects are JSON-serializable, should work
        if (result.success) {
            assert(result.returnValue !== null);
        }
    });

    it('CHAOS-605: state with many keys near limit', async function() {
        const vm = createVM({ maxStateKeys: 100 });
        // Pre-fill state to 99 keys (at limit - 1)
        const state = {};
        for (let i = 0; i < 99; i++) state['existing_' + i] = 'v';

        const code = `module.exports = function(xchain) {
            xchain.state.set('the_100th', 'value');  // should succeed (at limit)
            return 'ok';
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Should succeed at key limit: ' + result.error);
    });

    it('CHAOS-606: state at key limit + 1 write fails', async function() {
        const vm = createVM({ maxStateKeys: 100 });
        const state = {};
        for (let i = 0; i < 100; i++) state['existing_' + i] = 'v';

        const code = `module.exports = function(xchain) {
            xchain.state.set('over_limit', 'value');
            return 'should not reach here';
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Should fail over key limit');
        checkAtomicity(result);
    });

    it('CHAOS-607: state value at exactly maxStateValueSize', async function() {
        const vm = createVM({ maxStateValueSize: 1024 });
        const state = {};

        // Build a value that's exactly 1024 bytes when JSON-serialized
        // JSON.stringify("x".repeat(1022)) = '"' + 'x' * 1022 + '"' = 1024 bytes
        const code = `module.exports = function(xchain) {
            var big = '';
            for (var i = 0; i < 1022; i++) big += 'x';
            xchain.state.set('at_limit', big);
            return 'ok';
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Should succeed at value size limit: ' + result.error);
    });

    it('CHAOS-608: state value one byte over limit', async function() {
        const vm = createVM({ maxStateValueSize: 1024 });

        const code = `module.exports = function(xchain) {
            var big = '';
            for (var i = 0; i < 1023; i++) big += 'x';
            xchain.state.set('over_limit', big);
            return 'should fail';
        };`;

        const result = await execute(vm, code);
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Should fail over value size limit');
        checkAtomicity(result);
    });

    it('CHAOS-609: empty state object works normally', async function() {
        const vm = createVM();
        const result = await execute(vm, readerCode, { state: {} });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Empty state should work: ' + result.error);
    });

    it('CHAOS-610: state with array values', async function() {
        const vm = createVM();
        const state = { 'arr': [1, 2, 3, [4, 5]], 'nested_arr': [[['deep']]] };

        const code = `module.exports = function(xchain) {
            var arr = xchain.state.get('arr');
            var nested = xchain.state.get('nested_arr');
            return { arr: arr, nested: nested };
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Array state values should work: ' + result.error);
    });

    it('CHAOS-611: state with numeric string keys', async function() {
        const vm = createVM();
        const state = { '0': 'zero', '1': 'one', '999999': 'big' };

        const code = `module.exports = function(xchain) {
            return xchain.state.get('0') + ':' + xchain.state.get('999999');
        };`;

        const result = await execute(vm, code, { state });
        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Numeric string keys should work: ' + result.error);
    });

    it('CHAOS-612: VM recovers after all corrupted state tests', async function() {
        const vm = createVM();

        // Feed corrupted states
        const corrupted = [
            { '__proto__': { x: 1 } },
            { 'key\x00null': 'val' },
            Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['k' + i, 'v'])),
        ];

        for (const state of corrupted) {
            await execute(vm, readerCode, { state });
        }

        await chaosAssertions.assertRecovery(vm);
        checkNoPrototypePollution();
    });
});
