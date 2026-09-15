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
    XChainVM = require('../../src/index.js');
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

// SANDBOX ESCAPE VECTORS (RISK-01, RISK-02, RISK-03)

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    // --- RISK-01: Prototype chain traversal ---

    it('RISK-01a: Object.prototype.constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = ({}).constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'Object.prototype.constructor should be undefined, got: ' + val);
    });

    it('RISK-01b: Object.__proto__.constructor traversal should fail', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = ({}).__proto__.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'proto chain escape should be blocked, got: ' + val);
    });

    it('RISK-01c: Array.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = [].constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Array constructor should be neutered, got: ' + val);
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-01d: String.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = ''.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'String constructor should be neutered, got: ' + val);
    });

    it('RISK-01e: Number.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = (0).constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Number constructor should be neutered, got: ' + val);
    });

    it('RISK-01f: Boolean.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = true.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Boolean constructor should be neutered, got: ' + val);
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    // --- RISK-02: Function-type constructor variants ---

    it('RISK-02a: GeneratorFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var gen = (function*(){});
                    var GenCtor = Object.getPrototypeOf(gen).constructor;
                    return typeof GenCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'GeneratorFunction constructor should be neutered, got: ' + val);
    });

    it('RISK-02b: AsyncFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var af = (async function(){});
                    var AFCtor = Object.getPrototypeOf(af).constructor;
                    return typeof AFCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'AsyncFunction constructor should be neutered, got: ' + val);
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-02c: AsyncGeneratorFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var agf = (async function*(){});
                    var AGFCtor = Object.getPrototypeOf(agf).constructor;
                    return typeof AGFCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'AsyncGeneratorFunction constructor should be neutered, got: ' + val);
    });

    it('RISK-02d: [].constructor.constructor should not reach Function', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = [].constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'double-constructor escape should be blocked, got: ' + val);
    });

    it('RISK-02e: string.constructor.constructor should not reach Function', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = ''.constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'string constructor chain should be blocked, got: ' + val);
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-02f: RegExp.prototype.constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = /a/.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'RegExp constructor should be neutered, got: ' + val);
    });
});
