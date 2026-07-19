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
// Metered-source cache . meterCode() is the most expensive step of a
// warm execute; its output is a pure function of (code, specEvalOrder,
// meterCallSpread), so _getMeteredCode() memoizes it keyed on sha256(code) plus
// the two gate bits. These tests exercise the cache directly (no isolate, so
// they run on macOS where isolated-vm cannot dlopen): a hit must return the
// EXACT bytes a fresh meterCode() produces, the flags must partition the cache,
// and the bound must evict without ever returning stale output.

const assert = require('assert');
const XChainVM = require('../../src/index.js');
const { meterCode } = require('../../src/metering.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function cfg(extra) {
    return Object.assign(
        { gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process' },
        extra
    );
}

const CODE_A = 'module.exports = function(xchain){ let s = 0; for (let i=0;i<3;i++){ s += i; } return s; };';
const CODE_B = 'module.exports = { inc: function(xchain){ return xchain.state.get("n"); } };';

describe('XChainVM metered-source cache ', function () {

    it('starts empty and populates one entry on first meter', function () {
        const vm = new XChainVM(cfg());
        assert.strictEqual(vm._meteredCache.size, 0);
        vm._getMeteredCode(CODE_A, false, false);
        assert.strictEqual(vm._meteredCache.size, 1);
    });

    it('returns byte-identical output to a fresh meterCode() call', function () {
        const vm = new XChainVM(cfg());
        for (const [eo, cs] of [[false, false], [true, false], [false, true], [true, true]]) {
            const cached = vm._getMeteredCode(CODE_A, eo, cs);
            const fresh = meterCode(CODE_A, { specEvalOrder: eo, meterCallSpread: cs });
            assert.strictEqual(cached, fresh,
                'cached metered source must equal fresh meterCode output for flags ' + eo + '/' + cs);
        }
    });

    it('serves a repeated (code, flags) pair from cache without re-metering', function () {
        const vm = new XChainVM(cfg());
        // A hit keeps the cache flat AND returns the same reference the first miss
        // stored (re-metering would build and store a new string).
        const first = vm._getMeteredCode(CODE_A, false, false);
        assert.strictEqual(vm._meteredCache.size, 1);
        const second = vm._getMeteredCode(CODE_A, false, false);
        assert.strictEqual(vm._meteredCache.size, 1, 'a hit must not add a new entry');
        assert.strictEqual(second, first, 'a hit returns the stored (identical) string');
    });

    it('partitions the cache by each consensus gate flag', function () {
        const vm = new XChainVM(cfg());
        vm._getMeteredCode(CODE_A, false, false);
        vm._getMeteredCode(CODE_A, true, false);
        vm._getMeteredCode(CODE_A, false, true);
        vm._getMeteredCode(CODE_A, true, true);
        assert.strictEqual(vm._meteredCache.size, 4,
            'each distinct (specEvalOrder, meterCallSpread) pair is its own entry');
    });

    it('keys distinct sources to distinct entries', function () {
        const vm = new XChainVM(cfg());
        const a = vm._getMeteredCode(CODE_A, false, false);
        const b = vm._getMeteredCode(CODE_B, false, false);
        assert.strictEqual(vm._meteredCache.size, 2);
        assert.notStrictEqual(a, b);
    });

    it('defaults maxMeteredCacheSize from maxBlockCacheSize', function () {
        const vm = new XChainVM(cfg());
        assert.strictEqual(vm.limits.maxMeteredCacheSize, vm.limits.maxBlockCacheSize || 1000);
    });

    it('FIFO-evicts the oldest entry at capacity and never returns stale output', function () {
        const vm = new XChainVM(cfg({ limits: {
            maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000,
            maxStateValueSize: 65536, maxCodeSize: 65536, maxBlockCacheSize: 1000,
            maxMeteredCacheSize: 2
        } }));
        const srcs = [
            'module.exports = function(x){ return 1; };',
            'module.exports = function(x){ return 2; };',
            'module.exports = function(x){ return 3; };'
        ];
        vm._getMeteredCode(srcs[0], false, false);
        vm._getMeteredCode(srcs[1], false, false);
        assert.strictEqual(vm._meteredCache.size, 2);
        // Third distinct source evicts srcs[0] (oldest), size stays at bound.
        vm._getMeteredCode(srcs[2], false, false);
        assert.strictEqual(vm._meteredCache.size, 2, 'cache stays at its bound');
        // srcs[0] was evicted: fetching it re-meters (size stays 2, evicting srcs[1]),
        // and the returned value still equals a fresh meterCode() call (never stale).
        const refetched = vm._getMeteredCode(srcs[0], false, false);
        assert.strictEqual(refetched, meterCode(srcs[0], { specEvalOrder: false, meterCallSpread: false }));
        assert.strictEqual(vm._meteredCache.size, 2);
    });

    it('propagates a metering failure and does NOT cache it', function () {
        const vm = new XChainVM(cfg());
        const bad = 'module.exports = function(x){ this is not valid js @@@ ';
        assert.throws(() => vm._getMeteredCode(bad, false, false));
        assert.strictEqual(vm._meteredCache.size, 0, 'a metering failure must not populate the cache');
    });

    it('cache persists across block boundaries (not cleared by endBlock)', function () {
        const vm = new XChainVM(cfg());
        vm.beginBlock();
        vm._getMeteredCode(CODE_A, false, false);
        assert.strictEqual(vm._meteredCache.size, 1);
        vm.endBlock();
        // endBlock clears the per-block V8 cache but must leave the pure metered cache.
        assert.strictEqual(vm._meteredCache.size, 1,
            'metered-source cache is a pure function cache and survives endBlock');
    });
});
