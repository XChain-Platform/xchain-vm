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
 * WebAssembly global strip: per-coin Pkg 3 height gate (75190596 / )
 *
 * WebAssembly is a core V8 global reachable from contract code; a wasm body
 * carries no __gas instrumentation, so it runs unmetered native code (an
 * unmetered-CPU DoS + consensus-fork surface). The Package 3 bundle strips the
 * global at/after the per-coin ~961000 height flag-day (isPkg3SandboxActive,
 * threaded as stripGlobals opts.stripWasm), exactly like the Promise strip.
 *
 * This suite pins BOTH sides of the gate:
 *   - below each coin's height: WebAssembly is present (typeof 'object'),
 *     byte-identical to today;
 *   - at/after it: WebAssembly is undefined (stripped) and unreachable;
 *   - testnet/regtest: stripped from genesis;
 *   - per-coin: LTC/DOGE mainnet stay present at a bare BTC 961000 and strip
 *     only at their own calendar heights (the per-coin fix).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const TS = 1700000000; // any; the wasm strip keys on height, not block time.

const typeofWasm = `module.exports = function(xchain){ return typeof WebAssembly; };`;
// Above the gate, even reaching for a member must throw (global is absent).
const useWasm = `module.exports = function(xchain){ try { return typeof WebAssembly.instantiate; } catch (e) { return 'THROWN'; } };`;

(XChainVM ? describe : describe.skip)('WebAssembly strip: per-coin Pkg 3 height gate ', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM({ gasCeiling: 1000000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (code, height, network, coin) =>
        execute(vm, code, {
            method: 'default',
            blockContext: { height, timestamp: TS, hash: 'h' },
            network,
            contractAddress: 'C:' + (coin || 'BTC') + ':1',
        });

    it('below the BTC gate (960999), WebAssembly is present (typeof object, byte-identical to today)', async function () {
        const r = await run(typeofWasm, 960999, 'mainnet', 'BTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'object');
    });

    it('at the BTC gate (961000), WebAssembly is stripped (typeof undefined)', async function () {
        const r = await run(typeofWasm, 961000, 'mainnet', 'BTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
    });

    it('at the BTC gate, reaching WebAssembly.instantiate throws (global unreachable)', async function () {
        const r = await run(useWasm, 961000, 'mainnet', 'BTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'THROWN');
    });

    it('below the BTC gate, WebAssembly.instantiate is a real function (present pre-flag-day)', async function () {
        const r = await run(useWasm, 960999, 'mainnet', 'BTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'function');
    });

    // ---- Per-coin: LTC/DOGE stay present at a bare BTC 961000; strip at their own heights ----
    it('LTC mainnet at 961000 keeps WebAssembly present (per-coin fix: not a bare BTC gate)', async function () {
        const r = await run(typeofWasm, 961000, 'mainnet', 'LTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'object');
    });

    it('LTC mainnet at its proposed height (3154250) strips WebAssembly', async function () {
        const r = await run(typeofWasm, 3154250, 'mainnet', 'LTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
    });

    it('DOGE mainnet at 961000 keeps WebAssembly present (per-coin fix)', async function () {
        const r = await run(typeofWasm, 961000, 'mainnet', 'DOGE');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'object');
    });

    it('DOGE mainnet at its proposed height (6319000) strips WebAssembly', async function () {
        const r = await run(typeofWasm, 6319000, 'mainnet', 'DOGE');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
    });

    // ---- Pre-launch nets: the execute-time lint supersedes the strip  ----
    // The strip is the defence-in-depth layer for a contract that DEPLOYED before the
    // banned-wasm rule armed. Where execute-time source-lint enforcement is active (the
    // pre-launch nets, from genesis) such a contract can no longer execute at all: the
    // stored source is re-linted against the bans live at this block and rejected before
    // an isolate is even built, so the WebAssembly global is unreachable a layer earlier.
    // The strip itself stays pinned above, on mainnet, which is below the exec-lint gate.
    for (const network of ['testnet', 'regtest']) {
        it(`${network} rejects a WebAssembly-referencing contract at execute (lint supersedes the strip)`, async function () {
            const r = await run(typeofWasm, 0, network, 'BTC');
            assert.strictEqual(r.success, false);
            assert.ok(r.error.startsWith('error: banned syntax: '), r.error);
            assert.ok(/WebAssembly/.test(r.error), r.error);
        });
    }
});
