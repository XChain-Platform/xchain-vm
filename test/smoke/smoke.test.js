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
 * XChain VM — Smoke Tests
 *
 * Minimal, fast health-check suite (~9 scenarios, < 5 s target).
 * Verifies basic operational readiness: instantiation, sandbox,
 * contract execution, gateway interaction, and error handling.
 *
 * Run: npm run smoke
 */

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping smoke tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
};

const DEFAULT_LIMITS = {
    maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
    maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: DEFAULT_LIMITS
    });
}

function exec(vm, code, opts) {
    return vm.execute(Object.assign({
        code:            code,
        state:           {},
        method:          'default',
        params:          [],
        caller:          'smoke_test_addr',
        contractAddress: 'C:BTC:SMOKE',
        blockContext:     { height: 1000, timestamp: 1700000000, hash: 'smoke_hash_abc' }
    }, opts));
}

(XChainVM ? describe : describe.skip)('Smoke Tests', function() {

    // S1 — VM Instantiation
    describe('S1 — VM instantiation', function() {
        it('should construct and run beginBlock/endBlock lifecycle', function() {
            const vm = createVM();
            vm.beginBlock();
            vm.endBlock();
        });
    });

    // S2 — Sandbox Environment
    describe('S2 — Sandbox environment', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should strip non-deterministic globals (Date)', async function() {
            const result = await exec(vm,
                'module.exports = function(xchain) { return typeof Date; };');
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
        });
    });

    // S3 — Basic Contract Execution
    describe('S3 — Basic contract execution', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should execute a contract with state read/write and return a value', async function() {
            const result = await exec(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('counter', '0');
                    return xchain.state.get('counter');
                };
            `);
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), '0');
            assert(result.stateChanges.length > 0, 'should have state changes');
            assert(result.gasUsed > 0, 'should have consumed gas');
        });
    });

    // S4 — Multi-Method Dispatch
    describe('S4 — Multi-method dispatch', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should invoke a named method on an object export', async function() {
            const result = await exec(vm, `
                module.exports = {
                    greet: function(xchain) {
                        return 'hello';
                    },
                    farewell: function(xchain) {
                        return 'goodbye';
                    }
                };
            `, { method: 'greet' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'hello');
        });
    });

    // S5 — Platform Action Gateway — Emit
    describe('S5 — Gateway emit', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should emit a SEND action with correct fields', async function() {
            const result = await exec(vm, `
                module.exports = function(xchain) {
                    xchain.emit.send({ destination: 'recipient_addr', tick: 'SMOKE', quantity: '500' });
                    return 'emitted';
                };
            `);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.emittedActions.length, 1);
            assert.strictEqual(result.emittedActions[0].action, 'SEND');
            assert.strictEqual(result.emittedActions[0].params.destination, 'recipient_addr');
            assert.strictEqual(result.emittedActions[0].params.tick, 'SMOKE');
            assert.strictEqual(result.emittedActions[0].params.quantity, '500');
        });
    });

    // S6 — Platform Action Gateway — Context Accessors
    describe('S6 — Gateway context accessors', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should return correct block height, caller, and params', async function() {
            const result = await exec(vm, `
                module.exports = function(xchain) {
                    return {
                        height: xchain.getBlockHeight(),
                        caller: xchain.getSourceAddress(),
                        param0: xchain.getInputParam(0)
                    };
                };
            `, {
                caller: 'ctx_test_addr',
                params: ['arg_one', 'arg_two'],
                blockContext: { height: 42, timestamp: 1700000000, hash: 'ctx_hash' }
            });
            assert.strictEqual(result.success, true);
            const val = JSON.parse(result.returnValue);
            assert.strictEqual(val.height, 42);
            assert.strictEqual(val.caller, 'ctx_test_addr');
            assert.strictEqual(val.param0, 'arg_one');
        });
    });

    // S7 — Deterministic Math
    describe('S7 — Deterministic math', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should add two numbers via xchain.math.add', async function() {
            const result = await exec(vm,
                'module.exports = function(xchain) { return xchain.math.add("1", "2"); };');
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), '3');
        });
    });

    // S8 — Syntax Validation
    describe('S8 — Syntax validation', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should accept valid code', function() {
            const res = vm.validateSyntax('module.exports = function(xchain) { return 1; };');
            assert.strictEqual(res.valid, true);
        });

        it('should reject invalid code', function() {
            const res = vm.validateSyntax('function {{{');
            assert.strictEqual(res.valid, false);
            assert(typeof res.error === 'string' && res.error.length > 0);
        });
    });

    // S9 — Error Classification — Revert
    describe('S9 — Revert and atomicity', function() {
        let vm;
        before(function() { vm = createVM(); });

        it('should classify revert, preserve logs, and discard state/emissions', async function() {
            const result = await exec(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('key', 'value');
                    xchain.log('before revert');
                    xchain.revert('smoke revert');
                };
            `);
            assert.strictEqual(result.success, false);
            assert(result.error.startsWith('revert: '), 'error should start with "revert: "');
            assert(result.error.includes('smoke revert'));
            assert.strictEqual(result.stateChanges.length, 0, 'state changes must be discarded');
            assert.strictEqual(result.emittedActions.length, 0, 'emissions must be discarded');
            assert(result.logs.length > 0, 'logs should be preserved');
        });
    });
});
