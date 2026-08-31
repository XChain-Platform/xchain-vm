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
 * Toolkit: the simulator's DEFAULT block height must clear every per-coin
 * block-HEIGHT activation, or a mainnet simulation runs a rule set the live
 * chain has left behind.
 *
 * The sibling of simulator-block-time.test.js. The Package-3 sandbox bundle
 * (WebAssembly strip + the musl-safe recursion bound), the execute-time source
 * re-lint and the lint global-alias refinement do NOT key on block time: they
 * resolve `<COIN>:<network>` against an activation HEIGHT, and the simulator used
 * to seed a literal `height: 1`. BTC:mainnet passed 961000 (~2026-08-04), so a
 * `new ContractSimulator({ network: 'mainnet' })` simulated with WebAssembly still
 * present and passed contracts the chain now rejects.
 *
 * Two layers, and the second is the one that can go red for the right reason:
 * (1) the derived default clears the VM's own activation predicate; and (2) an
 * EXECUTED probe of a gated global, which returns the same answer under the
 * default mainnet simulator as under one pinned at the activation height, and a
 * DIFFERENT one under a pinned pre-activation height. A default that slipped back
 * to 1 makes layer 2 report the pre-activation answer and fail.
 *
 * The parity assertions on the activation map itself, including the cross-repo
 * pin against the indexer's deploy-half twin, live in
 * test/determinism/simulator-defaults-cross-repo.test.js (which `npm run ci`
 * runs); this file is the behavioural half.
 *
 * Needs the isolated-vm binding, so the require is guarded exactly as
 * simulator-block-time.test.js guards it: the suite SKIPS on a host where it
 * cannot dlopen (macOS dev box) and runs for real on Node 22 / Linux (CI).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
let XChainVM = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping simulator block-height tests (isolated-vm unavailable):', e.message);
}

// Reports whether the Pkg-3 sandbox stripped the gated global. 'undefined' at or
// after the activation height, 'object' below it.
const WASM_PROBE = `
module.exports = {
    probe: function (xchain) { return typeof WebAssembly; }
};
`;

// Captures console.warn for the duration of fn, restoring it even on a throw.
async function captureWarnings(fn) {
    const lines = [];
    const original = console.warn;
    console.warn = function (msg) { lines.push(String(msg)); };
    try { await fn(); } finally { console.warn = original; }
    return lines;
}

// Only the height-gate warning; the block-TIME warning has its own test file and
// its own trigger, and both can legitimately fire on the same run.
function heightWarnings(lines) {
    return lines.filter((l) => /block\.height|block-HEIGHT activation/.test(l));
}

(ContractSimulator ? describe : describe.skip)('toolkit: simulator default block height', function () {
    this.timeout(30000);

    it('seeds a mainnet simulator at an activation-clearing height, per coin', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            const sim = new ContractSimulator({ coin, network: 'mainnet' });
            assert.strictEqual(
                XChainVM.isPkg3SandboxActive('mainnet', coin, sim.block.height), true,
                'a default mainnet simulator for ' + coin + ' sits at height ' + sim.block.height +
                ', which the VM resolves as PRE Pkg-3-sandbox: the simulated rule set is not the ' +
                'one the live chain runs');
            // The default hash follows the derived height, the way advanceBlock names
            // every later block.
            assert.strictEqual(sim.block.hash,
                'sim_block_' + String(sim.block.height).padStart(16, '0'));
        }
    });

    it('leaves regtest/testnet and an explicit height alone', function () {
        assert.strictEqual(new ContractSimulator().block.height, 1);
        assert.strictEqual(new ContractSimulator({ network: 'testnet' }).block.height, 1);
        assert.strictEqual(new ContractSimulator().block.hash, 'sim_block_0000000000000001');
        const pinned = new ContractSimulator({ network: 'mainnet', block: { height: 7 } });
        assert.strictEqual(pinned.block.height, 7);
    });

    it('runs the post-activation rule set by default on mainnet', async function () {
        const armed = XChainVM.PKG3_SANDBOX_ACTIVATION['BTC:mainnet'];
        const dflt = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const atGate = new ContractSimulator({
            coin: 'BTC', network: 'mainnet', block: { height: armed } });
        const preGate = new ContractSimulator({
            coin: 'BTC', network: 'mainnet', block: { height: 1 } });
        try {
            const results = {};
            await captureWarnings(async function () {
                for (const [name, sim] of [['dflt', dflt], ['atGate', atGate], ['preGate', preGate]]) {
                    const dep = await sim.deploy(WASM_PROBE);
                    const res = await sim.call(dep.contractIndex, 'probe', []);
                    assert.ok(res.success, name + ' probe failed: ' + res.error);
                    results[name] = JSON.parse(res.returnValue);
                }
            });

            assert.strictEqual(results.preGate, 'object',
                'a pre-activation mainnet height should still see WebAssembly; if it does not, ' +
                'this probe no longer measures the Pkg-3 sandbox and the test below proves nothing');
            assert.strictEqual(results.atGate, 'undefined',
                'the Pkg-3 sandbox should strip WebAssembly at the activation height');
            assert.strictEqual(results.dflt, results.atGate,
                'a DEFAULT mainnet simulator saw WebAssembly as "' + results.dflt + '" while one ' +
                'pinned at the activation height saw "' + results.atGate + '": the default block ' +
                'height is below the gate, so `xchain-foundry simulate` accepts contracts the ' +
                'live chain rejects');
        } finally {
            await dflt.close();
            await atGate.close();
            await preGate.close();
        }
    });

    it('warns once when an author pins a pre-activation height', async function () {
        const sim = new ContractSimulator({ coin: 'BTC', network: 'mainnet', block: { height: 1 } });
        try {
            const lines = await captureWarnings(async function () {
                const dep = await sim.deploy(WASM_PROBE);
                await sim.call(dep.contractIndex, 'probe', []);
                await sim.call(dep.contractIndex, 'probe', []);
            });
            const warned = heightWarnings(lines);
            assert.strictEqual(warned.length, 1,
                'expected exactly one height-gate warning across two calls, got ' +
                JSON.stringify(lines));
            assert.ok(/Pkg-3 sandbox/.test(warned[0]), warned[0]);
            assert.ok(new RegExp(String(XChainVM.PKG3_SANDBOX_ACTIVATION['BTC:mainnet']))
                .test(warned[0]), warned[0]);
        } finally { await sim.close(); }
    });

    it('warns when the contract address resolves to no gated coin', async function () {
        const sim = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        try {
            const lines = await captureWarnings(async function () {
                // Not a C:<COIN>:<idx> address, so pkg3CoinFromAddress returns null and
                // every height gate resolves to inactive whatever the height is.
                const dep = await sim.deploy(WASM_PROBE, { contractAddress: 'nonsense' });
                await sim.call(dep.contractIndex, 'probe', []);
            });
            const warned = heightWarnings(lines);
            assert.strictEqual(warned.length, 1, JSON.stringify(lines));
            assert.ok(/no block-HEIGHT activation is armed/.test(warned[0]), warned[0]);
        } finally { await sim.close(); }
    });

    it('stays quiet on a default mainnet run and on regtest', async function () {
        const main = new ContractSimulator({ coin: 'BTC', network: 'mainnet' });
        const reg  = new ContractSimulator();
        try {
            const lines = await captureWarnings(async function () {
                for (const sim of [main, reg]) {
                    const dep = await sim.deploy(WASM_PROBE);
                    await sim.call(dep.contractIndex, 'probe', []);
                }
            });
            assert.deepStrictEqual(heightWarnings(lines), [],
                'the derived default already clears every armed gate, so warning there would ' +
                'train authors to ignore the warning');
        } finally {
            await main.close();
            await reg.close();
        }
    });
});
