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
