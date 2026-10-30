// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Flag-day Pkg 4: the constructor back-fills the core
// size caps (maxCodeSize / maxStateValueSize / maxStateKeys) like the
// cross-contract limits, so a caller passing a PARTIAL limits object can no
// longer silently disable the execute-time code-size cap (or the state caps).

'use strict';

const assert = require('assert');

let XChainVM = null;
try {
    XChainVM = require('../../../src/index.js'); // requires isolated-vm (Node 22 / Linux)
} catch (e) { /* skipped below */ }

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

(XChainVM ? describe : describe.skip)('constructor limits back-fill (bac14514)', function () {

    function make(limits) {
        return new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000,
                              execution: 'in-process', limits });
    }

    it('back-fills maxCodeSize/maxStateValueSize/maxStateKeys on a partial limits object', async function () {
        const vm = make({ maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50 });
        assert.strictEqual(vm.limits.maxCodeSize,       XChainVM.MAX_CODE_SIZE);
        assert.strictEqual(vm.limits.maxStateValueSize, 65536);
        assert.strictEqual(vm.limits.maxStateKeys,      10000);
    });

    it('preserves caller-supplied values (no clobbering)', async function () {
        const vm = make({ maxCodeSize: 1024, maxStateValueSize: 2048, maxStateKeys: 5 });
        assert.strictEqual(vm.limits.maxCodeSize,       1024);
        assert.strictEqual(vm.limits.maxStateValueSize, 2048);
        assert.strictEqual(vm.limits.maxStateKeys,      5);
    });

    it('leaves the no-limits default object unchanged', async function () {
        const vm = make(undefined);
        assert.strictEqual(vm.limits.maxCodeSize,       XChainVM.MAX_CODE_SIZE);
        assert.strictEqual(vm.limits.maxStateValueSize, 65536);
        assert.strictEqual(vm.limits.maxStateKeys,      10000);
    });

    it('a partial limits object no longer disables the execute-time code-size cap', async function () {
        const vm = make({ maxCpuTimeMs: 5000, maxMemory: 8 });
        vm.beginBlock();
        try {
            const big = 'module.exports = function(x) { return 1; };' +
                        '//'.padEnd(XChainVM.MAX_CODE_SIZE + 10, 'x');
            const res = await vm.execute({
                code: big, state: {}, method: 'default', params: [],
                caller: 'addr', contractAddress: 'C:BTC:TEST',
                blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
            });
            assert.strictEqual(res.success, false);
            assert.ok(/code size exceeds limit/.test(res.error), res.error);
        } finally {
            vm.endBlock();
        }
    });
});

(XChainVM ? describe : describe.skip)('constructor emission cap back-fill', function () {

    // Run a contract that emits `count` SENDs under a partial limits object.
    async function emitMany(count) {
        const vm = new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process',
                                  limits: { maxCpuTimeMs: 5000, maxMemory: 8 } });
        const lines = [];
        for (let i = 0; i < count; i++)
            lines.push('xchain.emit.send({ destination: "addr' + i + '", tick: "T", quantity: "1" });');
        vm.beginBlock();
        try {
            return await vm.execute({
                code: 'module.exports = function(xchain) {\n' + lines.join('\n') + '\n};',
                state: {}, method: 'default', params: [],
                caller: 'addr', contractAddress: 'C:BTC:TEST',
                blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
            });
        } finally {
            vm.endBlock();
        }
    }

    it('a partial limits object no longer disables the emission cap', async function () {
        const over = await emitMany(51);
        assert.strictEqual(over.success, false);
        assert.ok(/emission limit exceeded \(50\)/.test(over.error), over.error);
        const atCap = await emitMany(50);
        assert.strictEqual(atCap.success, true, atCap.error);
        assert.strictEqual(atCap.emittedActions.length, 50);
    });
});

describe('resolveLimits back-fills the emission cap', function () {
    const { resolveLimits } = require('../../../src/index/runtime/limits_defaults.js');

    it('defaults maxEmissions to 50 on a partial limits object', function () {
        assert.strictEqual(resolveLimits({ maxCpuTimeMs: 5000, maxMemory: 8 }).maxEmissions, 50);
    });

    it('keeps a caller-supplied maxEmissions and the no-limits default', function () {
        assert.strictEqual(resolveLimits({ maxEmissions: 7 }).maxEmissions, 7);
        assert.strictEqual(resolveLimits(undefined).maxEmissions, 50);
    });
});

describe('resolveLimits pins the recursion bound to the protocol constant', function () {
    const { resolveLimits } = require('../../../src/index/runtime/limits_defaults.js');
    const { MAX_STACK_DEPTH } = require('../../../src/index/constants.js');

    it('reports MAX_STACK_DEPTH whatever maxStackDepth the caller supplies', function () {
        for (const v of [0, -1, 1, 100, 512, 4000, 1.5, '600', null])
            assert.strictEqual(resolveLimits({ maxStackDepth: v }).maxStackDepth, MAX_STACK_DEPTH, String(v));
        assert.strictEqual(resolveLimits(undefined).maxStackDepth, MAX_STACK_DEPTH);
    });
});

(XChainVM ? describe : describe.skip)('a caller maxStackDepth cannot move the recursion bound', function () {

    // Recurse `depth` contract frames below every height gate (BTC, height 1).
    function recursion(depth) {
        return 'module.exports = function(xchain) {\n' +
               '    function f(k) { return k <= 0 ? 0 : 1 + f(k - 1); }\n' +
               '    return f(' + depth + ');\n' +
               '};';
    }

    async function run(vm, depth) {
        vm.beginBlock();
        try {
            const r = await vm.execute({
                code: recursion(depth), state: {}, method: 'default', params: [],
                caller: 'addr', contractAddress: 'C:BTC:TEST',
                blockContext: { height: 1, timestamp: 1700000000, hash: 'h' }
            });
            return { success: r.success, error: r.error, gasUsed: r.gasUsed, returnValue: r.returnValue };
        } finally {
            vm.endBlock();
        }
    }

    function make(limits) {
        return new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000,
                              execution: 'in-process', limits });
    }

    it('gives every override the default VM result at depths 300 and 600', async function () {
        const baseline = make(undefined);
        const expected = { 300: await run(baseline, 300), 600: await run(baseline, 600) };
        assert.strictEqual(expected[300].success, true, expected[300].error);
        assert.strictEqual(expected[600].success, false);
        for (const v of [0, -1, 100, 4000]) {
            const vm = make({ maxStackDepth: v });
            for (const depth of [300, 600])
                assert.deepStrictEqual(await run(vm, depth), expected[depth], 'maxStackDepth ' + v + ' at depth ' + depth);
        }
    });

    it('ignores maxStackDepth changed on vm.limits after construction', async function () {
        const expected = await run(make(undefined), 600);
        const vm = make(undefined);
        vm.limits.maxStackDepth = 0;
        assert.deepStrictEqual(await run(vm, 600), expected);
    });
});
