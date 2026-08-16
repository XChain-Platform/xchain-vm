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
// Execute-time consensus source-lint enforcement.
//
// The consensus source-lint bans were enforced at DEPLOY time only: execute()
// metered and ran the PERSISTED code with no re-check, so a contract accepted
// before a ban activated kept executing banned syntax afterwards. These tests
// pin the remedy on both sides of its activation:
//   - below the gate (mainnet, still unarmed) a banned-syntax contract executes
//     exactly as it did before, gasUsed included;
//   - at/after it (the genesis-active pre-launch nets) the execution fails
//     deterministically with a frozen 'error:' prefix;
//   - the verdict cache is invisible to consensus (same verdict, same gas, hit
//     or miss) and the lint gas is charged before the check, on a
//     source-length-derived divisor.
//
// Isolate-dependent (validateSyntax spawns an ivm.Isolate), so this suite runs
// on the Linux validator fleet, not on macOS.

const assert = require('assert');
const XChainVM = require('../../src/index.js');
const { isExecLintActive, EXEC_LINT_GAS_BYTES_PER_UNIT } = require('../../src/index.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function newVm(extra) {
    return new XChainVM(Object.assign(
        { gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, execution: 'in-process' },
        extra
    ));
}

// A contract that is CLEAN under every consensus rule.
const CLEAN = 'module.exports = function(xchain){ let s = 0; for (let i = 0; i < 3; i++) { s = s + i; } return s; };';

// Banned-generator (29912bd8): the Pkg 3 rule whose live instance motivated the item.
// The generator is never driven, so pre-activation this contract runs and returns 7.
const GENERATOR = 'function* g(){ yield 1; }\nmodule.exports = function(xchain){ return 7; };';

// banned-async (the block-time async gate leg).
const ASYNC = 'module.exports = function(xchain){ let p = Promise; return 7; };';

function runOpts(extra) {
    return Object.assign({
        code:            CLEAN,
        state:           {},
        method:          'default',
        params:          [],
        caller:          'bc1qcaller',
        contractAddress: 'C:BTC:1',
        contractIndex:   1,
        txHash:          'a'.repeat(64),
        blockContext:    { height: 961000, timestamp: 1786060800, hash: 'b'.repeat(64) }
    }, extra);
}

describe('execute-time consensus source-lint enforcement @regression @tier1', function () {
    this.timeout(30000);

    describe('below the activation (mainnet, still unarmed)', function () {

        it('a banned-generator contract still executes, exactly as before the change', async function () {
            const vm = newVm();
            const res = await vm.execute(runOpts({ code: GENERATOR, network: 'mainnet' }));
            assert.strictEqual(res.success, true,
                'mainnet is unarmed, so the stored generator contract must keep executing: ' + res.error);
            assert.strictEqual(JSON.parse(res.returnValue), 7);
        });

        it('charges NO lint gas: a trailing-comment pad cannot move gasUsed', async function () {
            // The pad changes the source LENGTH (and therefore what the lint charge would
            // be) without changing the metered AST, so identical gasUsed proves no
            // source-length-derived charge was levied below the gate.
            const vm = newVm();
            const bare   = await vm.execute(runOpts({ code: CLEAN, network: 'mainnet' }));
            const padded = await vm.execute(runOpts({
                code: CLEAN + '\n//' + 'x'.repeat(4096), network: 'mainnet'
            }));
            assert.strictEqual(bare.success, true, bare.error);
            assert.strictEqual(padded.success, true, padded.error);
            assert.strictEqual(padded.gasUsed, bare.gasUsed,
                'pre-activation gasUsed must be byte-identical to the historical charge');
        });

        it('populates no verdict-cache entry (the check never runs)', async function () {
            const vm = newVm();
            await vm.execute(runOpts({ code: GENERATOR, network: 'mainnet' }));
            assert.strictEqual(vm._lintVerdictCache.size, 0);
        });
    });

    describe('at/after the activation (genesis-active pre-launch nets)', function () {

        it('rejects a banned-generator contract deterministically', async function () {
            const vm = newVm();
            const res = await vm.execute(runOpts({ code: GENERATOR, network: 'regtest' }));
            assert.strictEqual(res.success, false);
            assert.ok(res.error.startsWith('error: banned syntax: '),
                'must use the frozen "error:" status prefix, got: ' + res.error);
            assert.ok(/generator/i.test(res.error), 'must name the violated rule: ' + res.error);
            // Atomicity: a rejected execution emits nothing and writes nothing.
            assert.deepStrictEqual(res.stateChanges, []);
            assert.deepStrictEqual(res.emittedActions, []);
        });

        it('is deterministic: the same rejection, byte for byte, across runs and VM instances', async function () {
            const a = await newVm().execute(runOpts({ code: GENERATOR, network: 'regtest' }));
            const b = await newVm().execute(runOpts({ code: GENERATOR, network: 'regtest' }));
            const c = await newVm().execute(runOpts({ code: GENERATOR, network: 'testnet' }));
            assert.strictEqual(a.error, b.error);
            assert.strictEqual(a.error, c.error);
            assert.strictEqual(a.gasUsed, b.gasUsed);
        });

        it('rejects a stored contract that references the banned async surface', async function () {
            const res = await newVm().execute(runOpts({ code: ASYNC, network: 'regtest' }));
            assert.strictEqual(res.success, false);
            assert.ok(res.error.startsWith('error: banned syntax: '), res.error);
        });

        it('leaves a clean contract succeeding with an unchanged return value', async function () {
            const res = await newVm().execute(runOpts({ code: CLEAN, network: 'regtest' }));
            assert.strictEqual(res.success, true, res.error);
            assert.strictEqual(JSON.parse(res.returnValue), 3);
        });
    });

    describe('lint gas is metered', function () {

        it('charges VM_COMPUTATION per EXEC_LINT_GAS_BYTES_PER_UNIT bytes of source', async function () {
            // Differential: two sources whose ONLY difference is a trailing comment meter
            // to the identical AST, so every gas charge except the source-length-derived
            // lint charge is equal. The delta therefore isolates the lint charge.
            const vm = newVm();
            const padLen = 4096;
            const padded = CLEAN + '\n//' + 'x'.repeat(padLen);
            assert.strictEqual(vm._getMeteredCode(CLEAN, false, false),
                vm._getMeteredCode(padded, false, false),
                'the pad must not change the metered AST, otherwise the differential is invalid');

            const bare = await vm.execute(runOpts({ code: CLEAN,  network: 'regtest' }));
            const wide = await vm.execute(runOpts({ code: padded, network: 'regtest' }));
            assert.strictEqual(bare.success, true, bare.error);
            assert.strictEqual(wide.success, true, wide.error);

            const units = (s) => Math.max(1, Math.ceil(
                Buffer.byteLength(s, 'utf8') / EXEC_LINT_GAS_BYTES_PER_UNIT));
            assert.strictEqual(wide.gasUsed - bare.gasUsed,
                GAS_SCHEDULE.VM_COMPUTATION * (units(padded) - units(CLEAN)),
                'lint gas must be VM_COMPUTATION * ceil(bytes / EXEC_LINT_GAS_BYTES_PER_UNIT)');
        });

        it('charges the lint BEFORE running it, so a ceiling below the charge is a clean out_of_gas', async function () {
            const vm = newVm({ gasCeiling: 1000000 });
            const big = CLEAN + '\n//' + 'x'.repeat(8192);
            const units = Math.ceil(Buffer.byteLength(big, 'utf8') / EXEC_LINT_GAS_BYTES_PER_UNIT);
            const ceiling = 5;                       // far below the lint charge
            assert.ok(units > ceiling, 'test needs a source whose lint charge exceeds the ceiling');
            const res = await vm.execute(runOpts({ code: big, network: 'regtest', gasCeiling: ceiling }));
            assert.strictEqual(res.success, false);
            assert.ok(res.error.startsWith('out_of_gas: '), res.error);
            assert.strictEqual(res.gasUsed, ceiling,
                'gasUsed must be clamped to the ceiling so the fee cannot exceed the committed budget');
        });

        it('bills identically on a cold and a warm cache (the cache cannot move gasUsed)', async function () {
            const vm = newVm();
            const cold = await vm.execute(runOpts({ code: CLEAN, network: 'regtest' }));
            assert.strictEqual(vm._lintVerdictCache.size, 1, 'first execute must populate the cache');
            const warm = await vm.execute(runOpts({ code: CLEAN, network: 'regtest' }));
            assert.strictEqual(vm._lintVerdictCache.size, 1, 'second execute must hit, not grow, the cache');
            assert.strictEqual(warm.gasUsed, cold.gasUsed);
        });
    });

    describe('verdict cache keyed by the metering sha256 key', function () {

        it('returns the verdict a fresh validateSyntax call produces', function () {
            const vm = newVm();
            const { validateSyntax } = require('../../src/syntax.js');
            for (const code of [CLEAN, GENERATOR, ASYNC]) {
                const cached = vm._getLintVerdict(code, true, true, true, true);
                const fresh  = validateSyntax(code, {
                    enforceBannedAsync: true, enforceLintHardening: true,
                    enforceBannedGenerator: true, enforceBannedWasm: true,
                    enforceLintGlobalAlias: true
                });
                assert.deepStrictEqual(cached, fresh, 'cached verdict drifted from a fresh one for: ' + code);
            }
        });

        it('partitions on the four consensus flag bits, not just the source', function () {
            const vm = newVm();
            vm._getLintVerdict(GENERATOR, false, false, false, false);
            vm._getLintVerdict(GENERATOR, true,  false, false, false);
            vm._getLintVerdict(GENERATOR, false, true,  false, false);
            vm._getLintVerdict(GENERATOR, false, false, true,  false);
            vm._getLintVerdict(GENERATOR, false, false, false, true);
            assert.strictEqual(vm._lintVerdictCache.size, 5);
            // And the flags actually change the verdict: the Pkg 3 bit is what bans the
            // generator, so the same source is valid with the bit off and invalid with it on.
            assert.strictEqual(vm._getLintVerdict(GENERATOR, false, false, false, false).valid, true);
            assert.strictEqual(vm._getLintVerdict(GENERATOR, false, false, true, false).valid, false);
            // The global-alias bit is a partition of its own: the same source is accepted
            // with it off and rejected with it on, which is what the epoch gate protects.
            const ALIASED = 'module.exports = function(){ return this.WebAssembly; };';
            assert.strictEqual(vm._getLintVerdict(ALIASED, true, true, true, false).valid, true);
            assert.strictEqual(vm._getLintVerdict(ALIASED, true, true, true, true).valid, false);
        });

        it('accepts the shared sha256 digest and keys identically to computing it itself', function () {
            const crypto = require('crypto');
            const vm = newVm();
            const hash = crypto.createHash('sha256').update(CLEAN).digest('hex');
            vm._getLintVerdict(CLEAN, true, true, true, true, hash);
            vm._getLintVerdict(CLEAN, true, true, true, true);
            assert.strictEqual(vm._lintVerdictCache.size, 1,
                'a shared digest and a self-computed one must produce the same cache key');
        });

        it('evicts FIFO at the bound instead of growing without limit', function () {
            const vm = newVm({ limits: { maxMeteredCacheSize: 2 } });
            vm._getLintVerdict(CLEAN,     true, true, true, true);
            vm._getLintVerdict(GENERATOR, true, true, true, true);
            vm._getLintVerdict(ASYNC,     true, true, true, true);
            assert.ok(vm._lintVerdictCache.size <= 2, 'cache must stay within its bound');
            // Correctness survives eviction: the evicted entry recomputes to the same verdict.
            assert.strictEqual(vm._getLintVerdict(CLEAN, true, true, true, true).valid, true);
        });
    });

    describe('activation resolver', function () {

        it('mainnet is unarmed at every height for every coin', function () {
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                assert.strictEqual(isExecLintActive('mainnet', coin, 0), false);
                assert.strictEqual(isExecLintActive('mainnet', coin, Number.MAX_SAFE_INTEGER), false);
            }
        });

        it('pre-launch nets are genesis-active; unknown network/coin and bad heights are off', function () {
            assert.strictEqual(isExecLintActive('regtest', 'BTC', 0), true);
            assert.strictEqual(isExecLintActive('testnet', 'LTC', 0), true);
            assert.strictEqual(isExecLintActive('stagenet', 'BTC', 999999999), false);
            assert.strictEqual(isExecLintActive('mainnet', 'XYZ', 999999999), false);
            assert.strictEqual(isExecLintActive('mainnet', 'BTC', 'nonsense'), false);
            assert.strictEqual(isExecLintActive('mainnet', 'BTC', undefined), false);
        });
    });
});
