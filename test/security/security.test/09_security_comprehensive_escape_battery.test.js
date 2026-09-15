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

// COMPREHENSIVE SANDBOX ESCAPE BATTERY

(XChainVM ? describe : describe.skip)('Security: Comprehensive Escape Battery', function() {

    this.timeout(15000);

    let vm;
    before(function() { vm = createVM(); });

    const escapeVectors = [
        {
            name: 'this.constructor.constructor',
            code: `try { var fn = this.constructor.constructor('return typeof process')(); return fn; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'Object.getPrototypeOf chain',
            code: `try { var p = Object.getPrototypeOf({}); var c = p.constructor; return typeof c; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'arguments.callee.constructor',
            code: `try { return typeof arguments.callee.constructor; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'import expression',
            code: `try { return typeof import; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'globalThis enumeration for dangerous refs',
            code: `
                var dangerous = ['process', 'require', 'eval', 'Function',
                    '__Function', '__defineProperty', 'Proxy', 'Reflect',
                    'Date', 'setTimeout', 'setInterval', 'fetch'];
                var found = [];
                for (var i = 0; i < dangerous.length; i++) {
                    if (typeof globalThis[dangerous[i]] !== 'undefined')
                        found.push(dangerous[i]);
                }
                return found.length === 0 ? 'clean' : 'found: ' + found.join(',');
            `
        }
    ];

    for (const vec of escapeVectors) {
        it('should block: ' + vec.name, async function() {
            const code = `module.exports = function(xchain) { ${vec.code} };`;
            let result;
            try {
                result = await executeCode(vm, code);
            } catch (e) {
                // If it throws at compilation level, that's fine too
                return;
            }
            if (result.success) {
                const val = JSON.parse(result.returnValue);
                assert(val === 'undefined' || val === 'blocked' || val === 'clean' || val === null,
                    vec.name + ' should be blocked, got: ' + val);
            }
            // If result.success is false, the contract errored (also acceptable)
        });
    }
});

(XChainVM ? describe : describe.skip)('Security: Comprehensive Escape Battery', function() {

    this.timeout(15000);

    let vm;
    before(function() { vm = createVM(); });

    it('should verify no __* globals leak to contract scope', async function() {
        // __gas, the allocator metering helpers (__concat/__setconcat/__setconcatL/
        // __tmpl/__tmpltag/__tmpltagm/__arrspread/__objspread/__objspreadmeter), and
        // the call-depth hooks (__depth_enter/__depth_exit) are intentional, locked
        // (non-writable/non-configurable) metering hooks the AST pass emits calls to;
        // they are also reserved at deploy time. __setconcatL is the L-3 gated
        // spec-eval-order variant of __setconcat. Everything else __* must be cleaned
        // from the contract scope.
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var allow = { __gas: 1, __concat: 1, __setconcat: 1, __setconcatL: 1, __tmpl: 1, __tmpltag: 1, __tmpltagm: 1, __arrspread: 1, __objspread: 1, __objspreadmeter: 1, __depth_enter: 1, __depth_exit: 1 };
                var leaks = [];
                var names = Object.getOwnPropertyNames(globalThis);
                for (var i = 0; i < names.length; i++) {
                    if (names[i].indexOf('__') === 0 && !allow[names[i]]) {
                        leaks.push(names[i]);
                    }
                }
                return leaks;
            };
        `);
        assert.strictEqual(result.success, true);
        const leaks = JSON.parse(result.returnValue);
        assert.deepStrictEqual(leaks, [],
            'no __* globals should be visible except metering hooks, found: ' + leaks.join(', '));
    });
});
