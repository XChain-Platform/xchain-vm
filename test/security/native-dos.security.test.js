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
 * Native-Operation DoS Tests
 *
 * Regression coverage for the gas-metering blind spot on native operations:
 * AST gas metering charges per __gas() point but NOT for the cost INSIDE a
 * single native operation, so BigInt arithmetic, RegExp backtracking, and large
 * native allocations could burn the full CPU/memory budget for ~0 gas. A block
 * packed with such EXECUTEs could exceed the indexer's block watchdog and halt
 * the chain.
 *
 * Mitigation (surface restriction):
 *   - BigInt is removed from the sandbox (no BigInt(x)); BigInt literals (10n)
 *     and RegExp literals (/.../), which expose unmetered native CPU, are
 *     rejected at deploy time (validateSyntax).
 *   - Everything else stays bounded by the gas ceiling, the 8MB memory limit,
 *     and the wall-clock safety net. Gas-exhaustion cannot be swallowed.
 *
 * These tests pin that behavior so a future change can't silently reopen the hole.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping native-dos tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling || 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs || 3000,
            maxMemory: overrides?.maxMemory || 8,
            maxEmissions: 50, maxStateKeys: 10000,
            maxStateValueSize: 65536, maxStateKeySize: 1024, maxCodeSize: 65536
        }
    });
}

function execute(vm, code, opts) {
    return vm.execute({
        code, state: opts?.state || {}, method: opts?.method || 'default',
        params: opts?.params || [], caller: 'test_addr', contractAddress: 'C:BTC:1',
        contractIndex: 1, txHash: '00'.repeat(32),
        // network + blockContext drive the async-surface flag-day gate (Promise
        // strip). Default to regtest, where the rule is active from genesis, so the
        // sandbox-hardening assertions below see the post-activation behaviour.
        network: opts?.network || 'regtest',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: {}, tokenInfo: {}
    });
}

const fn = (body) => `module.exports = function(){ ${body} };`;

describe('Native-op DoS: banned literals (deploy-time)', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM(); });

    it('rejects a BigInt literal', function () {
        const r = vm.validateSyntax(fn('return (2n ** 5000000n).toString();'));
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /bigint/i);
    });

    it('rejects a BigInt literal anywhere in the source', function () {
        const r = vm.validateSyntax('module.exports = { f: function(){ var x = 10n; return x; } };');
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /bigint/i);
    });

    it('rejects a RegExp literal', function () {
        const r = vm.validateSyntax(fn("return /(a+)+$/.test('aaaa!');"));
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /regex/i);
    });

    it('rejects a RegExp literal with flags', function () {
        const r = vm.validateSyntax(fn("return /foo/gi.test('FOO');"));
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /regex/i);
    });

    it('accepts benign code (no banned literals)', function () {
        assert.strictEqual(vm.validateSyntax(fn("return xchain.math.add('1','2');")).valid, true);
        assert.strictEqual(vm.validateSyntax(
            "module.exports = { inc: function(){ var c = parseInt(xchain.state.get('n')||'0'); xchain.state.set('n', String(c+1)); return String(c+1); } };").valid, true);
    });

    it('does not false-positive on the string "10n" or division', function () {
        assert.strictEqual(vm.validateSyntax(fn("return '10n' + (10 / 2);")).valid, true);
    });
});

describe('Async surface banned (deploy-time): async/await/Promise', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM(); });

    it('rejects an async function export', function () {
        const r = vm.validateSyntax('module.exports = { m: async function(x){ return 1; } };');
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /async/i);
    });

    it('rejects an async arrow export', function () {
        const r = vm.validateSyntax('module.exports = { m: async (x) => { return 1; } };');
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /async/i);
    });

    it('rejects an await expression', function () {
        const r = vm.validateSyntax('module.exports = { m: async function(){ await 0; return 1; } };');
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /async|await/i);
    });

    it('rejects a bare Promise reference', function () {
        const r = vm.validateSyntax(fn('return Promise.resolve(1);'));
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /promise/i);
    });

    it('rejects a new Promise(...) construction', function () {
        const r = vm.validateSyntax(fn('return new Promise(function(res){ res(1); });'));
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /promise/i);
    });

    it('does not false-positive on a property or key named Promise', function () {
        assert.strictEqual(vm.validateSyntax(fn("var o = { Promise: 1 }; return o.Promise;")).valid, true);
    });

    it('does not false-positive on the string "Promise" or "async"', function () {
        assert.strictEqual(vm.validateSyntax(fn("return 'async' + 'Promise';")).valid, true);
    });

    it('Promise is undefined inside the sandbox at runtime', async function () {
        const r = await execute(vm, fn('return typeof Promise;'));
        assert.strictEqual(r.success, true);
        assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
    });

    it('Promise is PRESENT below the async-surface flag-day on mainnet (replay parity)', async function () {
        // The Promise strip is consensus-gated on a block-time flag-day. A mainnet
        // execution below the flag day must leave the Promise global in place so a
        // from-genesis replay reproduces the historical pre-activation result; the
        // strip only engages at/after the coordinated activation.
        const r = await execute(vm, fn('return typeof Promise;'), {
            network: 'mainnet',
            blockContext: { height: 1, timestamp: 1700000000, hash: 'abc123' }
        });
        assert.strictEqual(r.success, true);
        assert.strictEqual(JSON.parse(r.returnValue), 'function');
    });
});

describe('Native-op DoS: BigInt removed at runtime', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM(); });

    it('BigInt constructor is undefined inside the sandbox', async function () {
        const r = await execute(vm, fn('return typeof BigInt;'));
        assert.strictEqual(r.success, true);
        assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
    });
});

describe('Native-op DoS: gas exhaustion cannot be swallowed', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM(); });

    it('catching GasExhaustedError in a loop still terminates with out_of_gas', async function () {
        const r = await execute(vm, fn(
            'var n=0; while(true){ try { var y=0; for(var i=0;i<50000;i++){ y+=i; } } catch(e){ n++; } }'));
        assert.strictEqual(r.success, false);
        assert.match(r.error, /out_of_gas|timeout/);
    });

    it('a bare throw/catch spin still terminates with out_of_gas', async function () {
        const r = await execute(vm, fn('while(true){ try { throw 1; } catch(e){} }'));
        assert.strictEqual(r.success, false);
        assert.match(r.error, /out_of_gas|timeout/);
    });

    it('the __gas hook cannot be overwritten to bypass metering', async function () {
        const r = await execute(vm, fn('try { __gas = function(){}; } catch(e){} var x=0; while(true){ x++; }'));
        assert.strictEqual(r.success, false);
        assert.match(r.error, /out_of_gas|timeout/);
    });
});

describe('Native-op DoS: residual native CPU is bounded by the safety net', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM({ maxCpuTimeMs: 1500 }); });

    // Even native operations the meter can't see (large allocations, deep work) must
    // be terminated by the memory limit or the wall-clock net — never hang the host.
    it('a huge array allocation is contained (no hang, no crash)', async function () {
        const r = await execute(vm, fn("var a=[]; while(true){ a.push(new Array(100000).fill(7)); }"));
        assert.strictEqual(r.success, false);
        assert.match(r.error, /timeout|memory|out_of_gas|string|length/i);
    });

    it('deep recursion is contained', async function () {
        const r = await execute(vm, fn('function f(n){ return f(n+1); } return f(0);'));
        assert.strictEqual(r.success, false);
    });
});
