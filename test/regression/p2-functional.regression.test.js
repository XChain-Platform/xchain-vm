/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

// 


const assert = require('assert');
const { createVM, execute, GAS_SCHEDULE } = require('./helpers.js');

// ── Direct module imports for unit-level regression ─────────────
const { meterCode, hasGasIdentifier } = require('../../src/metering.js');
const { buildMathAPI } = require('../../src/math.js');
const { buildEmitAPI } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const StateManager = require('../../src/state.js');
const EmissionCollector = require('../../src/collector.js');
const ActionValidator = require('../../src/validator.js');
const { validateSyntax, checkFloatWarnings } = require('../../src/syntax.js');
const { GasExhaustedError, ContractRevertError } = require('../../src/errors.js');

describe('[P2] Functional Regression', function() {

    // ================================================================
    // GAS METERING INJECTION
    // ================================================================
    describe('Gas metering injection', function() {

        const AST_NODES = [
            { name: 'for loop',         code: 'for (var i = 0; i < 10; i++) { x++; }' },
            { name: 'while loop',       code: 'while (x > 0) { x--; }' },
            { name: 'do-while loop',    code: 'do { x--; } while (x > 0);' },
            { name: 'for-in loop',      code: 'for (var k in obj) { arr.push(k); }' },
            { name: 'for-of loop',      code: 'for (var v of arr) { sum += v; }' },
            { name: 'if statement',     code: 'if (x > 0) { y = 1; } else { y = 2; }' },
            { name: 'switch case',      code: 'switch(x) { case 1: y=1; break; default: y=0; }' },
            { name: 'ternary',          code: 'var y = x > 0 ? 1 : 2;' },
            { name: 'try/catch',        code: 'try { x(); } catch(e) { y(); } finally { z(); }' },
            { name: 'function decl',    code: 'function foo() { return 1; }' },
            { name: 'function expr',    code: 'var foo = function() { return 1; };' },
            { name: 'arrow block',      code: 'var foo = () => { return 1; };' },
            { name: 'call expression',  code: 'foo(); bar(); baz();' }
        ];

        for (const { name, code } of AST_NODES) {
            it(`should inject __gas into ${name}`, function() {
                const metered = meterCode(code);
                assert(metered.includes('__gas'), `${name} missing __gas injection`);
            });
        }

        it('should detect __gas identifier in user code', function() {
            assert.strictEqual(hasGasIdentifier('var __gas = 1;'), true);
            assert.strictEqual(hasGasIdentifier('var x = 1;'), false);
        });
    });

    // ================================================================
    // GAS TRACKER
    // ================================================================
    describe('GasTracker', function() {

        it('should start at 0 and accumulate charges', function() {
            const t = new GasTracker(GAS_SCHEDULE, 1000);
            assert.strictEqual(t.getUsed(), 0);
            t.charge(100);
            assert.strictEqual(t.getUsed(), 100);
        });

        it('should allow charge exactly at ceiling', function() {
            const t = new GasTracker(GAS_SCHEDULE, 100);
            t.charge(100);
            assert.strictEqual(t.getUsed(), 100);
        });

        it('should throw GasExhaustedError when ceiling exceeded', function() {
            const t = new GasTracker(GAS_SCHEDULE, 100);
            assert.throws(() => t.charge(101), GasExhaustedError);
        });

        it('should reject negative charge', function() {
            const t = new GasTracker(GAS_SCHEDULE, 1000);
            assert.throws(() => t.charge(-1), /non-negative/);
        });

        it('should reject invalid schedule values', function() {
            assert.throws(() => new GasTracker({ ...GAS_SCHEDULE, VM_COMPUTATION: -1 }, 1000));
            assert.throws(() => new GasTracker({ ...GAS_SCHEDULE, VM_COMPUTATION: 1.5 }, 1000));
            assert.throws(() => new GasTracker({ ...GAS_SCHEDULE, VM_COMPUTATION: 'x' }, 1000));
        });
    });

    // ================================================================
    // STATE MANAGER
    // ================================================================
    describe('StateManager', function() {

        const LIMITS = { maxStateKeys: 10, maxStateValueSize: 1024, maxStateKeySize: 1024 };

        it('should read/write/delete/has', function() {
            const sm = new StateManager({}, LIMITS);
            sm.set('k', 'v');
            assert.strictEqual(sm.get('k'), 'v');
            assert.strictEqual(sm.has('k'), true);
            sm.delete('k');
            assert.strictEqual(sm.get('k'), null);
            assert.strictEqual(sm.has('k'), false);
        });

        it('should reject null, undefined, NaN, Infinity values', function() {
            const sm = new StateManager({}, LIMITS);
            assert.throws(() => sm.set('k', null), /null or undefined/);
            assert.throws(() => sm.set('k', undefined), /null or undefined/);
            assert.throws(() => sm.set('k', NaN), /NaN or Infinity/);
            assert.throws(() => sm.set('k', Infinity), /NaN or Infinity/);
            assert.throws(() => sm.set('k', -Infinity), /NaN or Infinity/);
        });

        it('should enforce max key count', function() {
            const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 2 });
            sm.set('a', '1');
            sm.set('b', '2');
            assert.throws(() => sm.set('c', '3'), /max state keys/);
        });

        it('should enforce max value size', function() {
            const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 10 });
            assert.throws(() => sm.set('k', 'a'.repeat(100)), /max size/);
        });

        it('should enforce max key size', function() {
            const sm = new StateManager({}, { ...LIMITS, maxStateKeySize: 16 });
            assert.throws(() => sm.set('a'.repeat(17), 'v'), /key exceeds max size/);
        });

        it('should collect changes correctly with delete-set cycles', function() {
            const sm = new StateManager({ x: 'old' }, LIMITS);
            sm.set('x', 'new');
            sm.delete('x');
            sm.set('y', 'added');
            const { changes, deletes } = sm.getChanges();
            assert.deepStrictEqual(deletes, ['x']);
            assert.deepStrictEqual(changes, [{ key: 'y', value: 'added' }]);
        });

        it('should free slots after delete', function() {
            const sm = new StateManager({}, { ...LIMITS, maxStateKeys: 2 });
            sm.set('a', '1');
            sm.set('b', '2');
            sm.delete('a');
            sm.set('c', '3'); // should succeed
            assert.strictEqual(sm.get('c'), '3');
        });
    });

    // ================================================================
    // EMISSION COLLECTOR
    // ================================================================
    describe('EmissionCollector', function() {

        it('should collect and copy params', function() {
            const ec = new EmissionCollector(50);
            const p = { destination: 'a', tick: 'T', quantity: '1' };
            ec.add('SEND', p);
            p.quantity = '999'; // mutate original
            assert.strictEqual(ec.getActions()[0].params.quantity, '1');
        });

        it('should enforce emission limit', function() {
            const ec = new EmissionCollector(3);
            ec.add('SEND', { a: '1' });
            ec.add('SEND', { a: '2' });
            ec.add('SEND', { a: '3' });
            assert.throws(() => ec.add('SEND', { a: '4' }), /emission limit/);
        });

        it('should cap logs at 100', function() {
            const ec = new EmissionCollector(50);
            for (let i = 0; i < 150; i++) ec.addLog('msg');
            assert.strictEqual(ec.getLogs().length, 100);
            assert.strictEqual(ec.isLogFull(), true);
        });

        it('should truncate log messages over 1024 bytes', function() {
            const ec = new EmissionCollector(50);
            ec.addLog('x'.repeat(2000));
            assert(ec.getLogs()[0].endsWith('...(truncated)'));
        });
    });

    // ================================================================
    // ALL 16 EMIT TYPES
    // ================================================================
    describe('All 16 emit types', function() {

        function createEmit() {
            const gt = new GasTracker(GAS_SCHEDULE, 1000000);
            const col = new EmissionCollector(50);
            const emit = buildEmitAPI(gt, col, GAS_SCHEDULE);
            return { emit, col, gt };
        }

        const EMIT_TESTS = [
            { method: 'send',      params: { destination: 'a', tick: 'T', quantity: '1' },         action: 'SEND' },
            { method: 'destroy',   params: { tick: 'T', quantity: '1' },                           action: 'DESTROY' },
            { method: 'issue',     params: { tick: 'NEW' },                                        action: 'ISSUE' },
            { method: 'mint',      params: { tick: 'T', quantity: '1' },                           action: 'MINT' },
            { method: 'order',     params: { giveAmount: '100', getAmount: '50' },                 action: 'ORDER' },
            { method: 'dispenser', params: { tick: 'T' },                                          action: 'DISPENSER' },
            { method: 'dividend',  params: { tick: 'T', dividendTick: 'D', quantity: '1' },        action: 'DIVIDEND' },
            { method: 'airdrop',   params: { tick: 'T', quantity: '1', listActionIndex: 5 },       action: 'AIRDROP' },
            { method: 'callback',  params: { tick: 'T' },                                          action: 'CALLBACK' },
            { method: 'file',      params: { data: 'x' },                                         action: 'FILE' },
            { method: 'list',      params: { items: ['a'] },                                       action: 'LIST' },
            { method: 'coinpay',   params: { orderMatchActionIndex: 1 },                           action: 'COINPAY' },
            { method: 'sweep',     params: { destination: 'a' },                                   action: 'SWEEP' },
            { method: 'link',      params: { coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }, action: 'LINK' },
            { method: 'broadcast', params: { data: 'msg' },                                        action: 'BROADCAST' },
            { method: 'message',   params: { destination: 'a', body: 'hi' },                       action: 'MESSAGE' }
        ];

        for (const { method, params, action } of EMIT_TESTS) {
            it(`should queue ${action} via emit.${method}()`, function() {
                const { emit, col } = createEmit();
                emit[method](params);
                assert.strictEqual(col.getActions()[0].action, action);
            });
        }

        it('should charge VM_EMISSION gas per emit', function() {
            const { emit, gt } = createEmit();
            emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            assert.strictEqual(gt.getUsed(), GAS_SCHEDULE.VM_EMISSION);
        });

        // Required field validation for critical types
        it('should reject send without destination', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ tick: 'T', quantity: '1' }), /destination/);
        });

        it('should reject send without tick', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ destination: 'a', quantity: '1' }), /tick/);
        });

        it('should reject send without quantity', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ destination: 'a', tick: 'T' }), /quantity/);
        });

        it('should reject non-object params', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send('string'), /params must be an object/);
            assert.throws(() => emit.send(null), /params must be an object/);
        });
    });

    // ================================================================
    // ACTION VALIDATOR
    // ================================================================
    describe('ActionValidator', function() {

        const ALLOWED = [
            'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER', 'DISPENSER',
            'DIVIDEND', 'AIRDROP', 'CALLBACK', 'FILE', 'LIST', 'COINPAY',
            'SWEEP', 'LINK', 'BROADCAST', 'MESSAGE'
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
            assert.throws(() => validator.validate({ action: 'EXECUTE', params: {} }), /unknown/);
            assert.throws(() => validator.validate({ action: 'send', params: {} }), /unknown/);
        });

        it('should reject null/undefined params', function() {
            assert.throws(() => validator.validate({ action: 'SEND', params: null }), /params/);
            assert.throws(() => validator.validate({ action: 'SEND', params: undefined }), /params/);
        });
    });

    // ================================================================
    // DETERMINISTIC MATH
    // ================================================================
    describe('Deterministic math', function() {

        const math = buildMathAPI();

        it('should handle basic arithmetic', function() {
            assert.strictEqual(math.add('1', '2'), '3');
            assert.strictEqual(math.subtract('10', '3'), '7');
            assert.strictEqual(math.multiply('6', '7'), '42');
            assert.strictEqual(math.divide('10', '4'), '2.5');
            assert.strictEqual(math.mod('10', '3'), '1');
        });

        it('should handle decimal precision (0.1 + 0.2 = 0.3)', function() {
            assert.strictEqual(math.add('0.1', '0.2'), '0.3');
        });

        it('should handle large numbers', function() {
            const big = '99999999999999999999999999999999999999999999999999';
            assert.strictEqual(math.add(big, '1'),
                '100000000000000000000000000000000000000000000000000');
        });

        it('should provide correct comparisons', function() {
            assert.strictEqual(math.compare('10', '5'), 1);
            assert.strictEqual(math.compare('5', '10'), -1);
            assert.strictEqual(math.compare('5', '5'), 0);
            assert.strictEqual(math.gt('10', '5'), true);
            assert.strictEqual(math.lt('5', '10'), true);
            assert.strictEqual(math.eq('5', '5'), true);
        });

        it('should revert on division by zero', function() {
            assert.throws(() => math.divide('1', '0'));
        });

        it('should reject inputs exceeding 256 chars', function() {
            assert.throws(() => math.add('1'.repeat(257), '1'));
        });
    });

    // ================================================================
    // SYNTAX VALIDATION
    // ================================================================
    describe('Syntax validation', function() {

        it('should accept valid ES2020', function() {
            assert.strictEqual(validateSyntax('var x = a?.b ?? "d";').valid, true);
        });

        it('should reject syntax errors', function() {
            assert.strictEqual(validateSyntax('function { invalid }').valid, false);
        });

        it('should reject __gas identifier', function() {
            assert.strictEqual(validateSyntax('var __gas = 1;').valid, false);
            assert.strictEqual(validateSyntax('function __gas() {}').valid, false);
            assert.strictEqual(validateSyntax('let __gas = 42;').valid, false);
        });

        it('should allow string "__gas"', function() {
            assert.strictEqual(validateSyntax('var x = "__gas";').valid, true);
        });

        it('should detect float warnings', function() {
            assert(checkFloatWarnings('var x = 0.1;').length > 0);
            assert.strictEqual(checkFloatWarnings('var x = 42;').length, 0);
            assert.strictEqual(checkFloatWarnings('var x = "0.1";').length, 0);
        });
    });

    // ================================================================
    // ERROR CLASSES
    // ================================================================
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

    // ================================================================
    // FULL EMIT PIPELINE (integration through VM)
    // ================================================================
    describe('Full emit pipeline through VM', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should emit all 16 types through real execution', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
                    xchain.emit.destroy({ tick: 'T', quantity: '1' });
                    xchain.emit.issue({ tick: 'N' });
                    xchain.emit.mint({ tick: 'T', quantity: '1' });
                    xchain.emit.order({ giveAmount: '1', getAmount: '1' });
                    xchain.emit.dispenser({ tick: 'T' });
                    xchain.emit.dividend({ tick: 'T', dividendTick: 'D', quantity: '1' });
                    xchain.emit.airdrop({ tick: 'T', quantity: '1', listActionIndex: 1 });
                    xchain.emit.callback({ tick: 'T' });
                    xchain.emit.file({ data: 'x' });
                    xchain.emit.list({ items: ['a'] });
                    xchain.emit.coinpay({ orderMatchActionIndex: 1 });
                    xchain.emit.sweep({ destination: 'a' });
                    xchain.emit.link({ coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 });
                    xchain.emit.broadcast({ data: 'm' });
                    xchain.emit.message({ destination: 'a', body: 'h' });
                    return 'all emitted';
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.emittedActions.length, 16);
            const types = r.emittedActions.map(a => a.action);
            assert(types.includes('SEND'));
            assert(types.includes('DESTROY'));
            assert(types.includes('ISSUE'));
            assert(types.includes('MINT'));
            assert(types.includes('ORDER'));
            assert(types.includes('DISPENSER'));
            assert(types.includes('DIVIDEND'));
            assert(types.includes('AIRDROP'));
            assert(types.includes('CALLBACK'));
            assert(types.includes('FILE'));
            assert(types.includes('LIST'));
            assert(types.includes('COINPAY'));
            assert(types.includes('SWEEP'));
            assert(types.includes('LINK'));
            assert(types.includes('BROADCAST'));
            assert(types.includes('MESSAGE'));
        });
    });
});
