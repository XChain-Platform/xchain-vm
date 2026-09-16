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
const { GAS_SCHEDULE } = require('./helpers/harness.js');

// Direct module imports for unit-level regression
const { meterCode, hasGasIdentifier } = require('../../src/metering.js');
const GasTracker = require('../../src/gas.js');
const StateManager = require('../../src/state.js');
const EmissionCollector = require('../../src/collector.js');
const { GasExhaustedError } = require('../../src/errors.js');

describe('[P2] Functional Regression', function() {

    // GAS METERING INJECTION
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
});

describe('[P2] Functional Regression', function() {
    // GAS TRACKER
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
});

describe('[P2] Functional Regression', function() {
    // STATE MANAGER
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
    });
});

describe('[P2] Functional Regression', function() {
    // STATE MANAGER
    describe('StateManager', function() {

        const LIMITS = { maxStateKeys: 10, maxStateValueSize: 1024, maxStateKeySize: 1024 };

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
});

describe('[P2] Functional Regression', function() {
    // EMISSION COLLECTOR
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
});
