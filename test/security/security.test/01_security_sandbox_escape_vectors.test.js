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

// SANDBOX ESCAPE VECTORS (RISK-01, RISK-02, RISK-03)

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    // --- RISK-03: Reflect removal ---

    it('RISK-03: Reflect should be removed from sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof Reflect;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // --- RegExp removal (M-07) ---

    it('M-07a: RegExp global should be undefined', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof RegExp;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('M-07b: regex literals should still work (V8 built-in)', async function() {
        // Regex literals are compiled by V8, not the RegExp constructor
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return /hello/.test('hello world');
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), true);
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('M-07c: String regex methods (match/matchAll/search) are neutered', async function() {
        // These coerce a string argument to a RegExp via the %RegExp% intrinsic,
        // so they would otherwise run ReDoS-prone backtracking past both the
        // RegExp-global deletion and the deploy-time regex-literal linter, burning
        // unbounded wall-clock for ~1 gas unit (a wall-clock-dependent fork risk).
        for (const method of ['match', 'matchAll', 'search']) {
            const result = await executeCode(vm, `
                module.exports = function(xchain) {
                    try {
                        ''.${method}('(a+)+$');
                        return 'available';
                    } catch(e) {
                        return 'blocked';
                    }
                };
            `);
            assert.strictEqual(result.success, true, method + ' execution');
            assert.strictEqual(JSON.parse(result.returnValue), 'blocked',
                'String.prototype.' + method + ' should be neutered');
        }
    });

    // --- Object.defineProperty removal ---

    it('should block Object.defineProperty inside contracts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Object.defineProperty({}, 'x', { get: function() { return 1; } });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('should block Object.defineProperties inside contracts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Object.defineProperties({}, { x: { value: 1 } });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should allow Object.create(null) but block descriptor argument', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var results = [];
                // Object.create(null) should work
                try {
                    var obj = Object.create(null);
                    results.push('create-null:ok');
                } catch(e) {
                    results.push('create-null:blocked');
                }
                // Object.create with descriptors should be blocked
                try {
                    Object.create(null, { x: { value: 1 } });
                    results.push('create-desc:ok');
                } catch(e) {
                    results.push('create-desc:blocked');
                }
                return results;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val.includes('create-null:ok'), 'Object.create(null) should work');
        assert(val.includes('create-desc:blocked'), 'Object.create with descriptors should be blocked');
    });

    // --- Error.stack information leakage ---

    it('Error.stack should not reveal host file paths', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    throw new Error('test');
                } catch(e) {
                    return e.stack || 'no stack';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        // Should not contain host paths like /home, /usr, node_modules, etc.
        // Isolate stacks typically don't have host paths, but verify
        assert(!val.includes('/home/'), 'stack should not contain /home paths');
        assert(!val.includes('node_modules'), 'stack should not contain node_modules');
    });
});

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    // --- __defineProperty cleanup ---

    it('__defineProperty should not be accessible to contract code', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof globalThis.__defineProperty;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // --- __Function cleanup ---

    it('__Function should not be accessible to contract code', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof globalThis.__Function;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });
});
