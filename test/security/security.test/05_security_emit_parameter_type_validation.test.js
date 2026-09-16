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

// EMIT PARAMETER TYPE VALIDATION (M-13)

(XChainVM ? describe : describe.skip)('Security: Emit Parameter Type Validation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should reject SEND with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 123, tick: 'T', quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject SEND with non-string tick', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 42, quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject SEND with non-string quantity', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: 100 });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject DESTROY with non-string tick', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.destroy({ tick: ['array'], quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject MINT with object quantity', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.mint({ tick: 'T', quantity: { value: '100' } });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });
});

(XChainVM ? describe : describe.skip)('Security: Emit Parameter Type Validation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should reject ORDER with non-string amounts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.order({ giveAmount: 100, getAmount: '200' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should accept valid SEND with all string params', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 'TOKEN', quantity: '100' });
                return 'ok';
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 1);
    });

    it('should reject SWEEP with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.sweep({ destination: 12345 });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject MESSAGE with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.message({ destination: null });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('missing required field'), 'got: ' + result.error);
    });

    it('should reject DIVIDEND with non-string fields', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.dividend({ tick: 123, dividendTick: 'T', quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });
});
