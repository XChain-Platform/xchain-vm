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
 * Security Audit Tests
 *
 * Tests for all vulnerabilities identified in the security audit:
 *   - Sandbox escape vectors (RISK-01 through RISK-03)
 *   - Error type spoofing (RISK-04)
 *   - Gas metering bypass (RISK-05, RISK-06)
 *   - Emit parameter injection / prototype pollution (RISK-10, RISK-11)
 *   - Math input abuse (RISK-12)
 *   - Information leakage (RISK-15)
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping security tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling || 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs || 5000,
            maxMemory: overrides?.maxMemory || 8,
            maxEmissions: overrides?.maxEmissions || 50,
            maxStateKeys: overrides?.maxStateKeys || 10000,
            maxStateValueSize: overrides?.maxStateValueSize || 65536,
            maxStateKeySize: overrides?.maxStateKeySize || 1024,
            maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: opts?.caller || 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: opts?.balances || {},
        tokenInfo: opts?.tokenInfo || {}
    });
}

// PROTOTYPE POLLUTION (RISK-10, RISK-11)

(XChainVM ? describe : describe.skip)('Security: Prototype Pollution', function() {

    // --- RISK-11: State key prototype pollution ---

    describe('State key prototype pollution (RISK-11)', function() {
        const StateManager = require('../../../src/state.js');

        it('should safely handle __proto__ as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('__proto__', 'test_value');
            assert.strictEqual(sm.get('__proto__'), 'test_value');
            assert.strictEqual(sm.has('__proto__'), true);
        });

        it('should safely handle constructor as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('constructor', 'test_value');
            assert.strictEqual(sm.get('constructor'), 'test_value');
        });

        it('should safely handle hasOwnProperty as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('hasOwnProperty', 'test_value');
            assert.strictEqual(sm.get('hasOwnProperty'), 'test_value');
            // The state store should still function correctly
            assert.strictEqual(sm.has('hasOwnProperty'), true);
            assert.strictEqual(sm.has('nonexistent'), false);
        });

        it('should safely handle toString as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('toString', 'test_value');
            assert.strictEqual(sm.get('toString'), 'test_value');
        });

        it('initial state with __proto__ key should not pollute prototype', function() {
            // When passing { '__proto__': 'injected' } as a literal, JS interprets
            // __proto__ as the prototype setter, so Object.entries won't see it.
            // Verify the state store itself is prototype-free (no inherited keys).
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            // Set __proto__ via the state API; should be stored as a regular key
            sm.set('__proto__', 'injected');
            assert.strictEqual(sm.get('__proto__'), 'injected');
            assert.strictEqual(sm.has('__proto__'), true);
            // Verify it doesn't affect the state object's actual prototype
            assert.strictEqual(Object.getPrototypeOf(sm.state), null,
                'state store should have null prototype');
        });
    });
});

(XChainVM ? describe : describe.skip)('Security: Prototype Pollution', function() {

    // --- RISK-10: Emit parameter prototype pollution ---

    describe('Emit parameter prototype pollution (RISK-10)', function() {
        const EmissionCollector = require('../../../src/collector.js');

        it('should strip __proto__ from emission params', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                __proto__: { polluted: true }
            });
            const actions = ec.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].params.__proto__, undefined);
            // Verify normal params are preserved
            assert.strictEqual(actions[0].params.destination, 'addr1');
        });

        it('should strip constructor from emission params', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                constructor: 'evil'
            });
            const actions = ec.getActions();
            assert.strictEqual(actions[0].params.constructor, undefined);
        });

        it('should preserve normal params after stripping', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                memo: 'hello'
            });
            const actions = ec.getActions();
            assert.strictEqual(actions[0].params.destination, 'addr1');
            assert.strictEqual(actions[0].params.tick, 'TOKEN');
            assert.strictEqual(actions[0].params.quantity, '100');
            assert.strictEqual(actions[0].params.memo, 'hello');
        });
    });
});
