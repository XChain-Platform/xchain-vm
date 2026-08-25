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
 * Toolkit: the simulator's DEFAULT block time must sit at/after every
 * block-TIME-keyed VM activation, or simulated gas is charged under a rule set
 * no live chain runs.
 *
 * The F3 binary-constructor / F3-globals meters, the O(n)-copy meter upgrades,
 * math-output metering, the emission proto-strip and the non-finite gas clamp
 * all compare blockContext.timestamp against a *_GATE_BLOCK_TIME constant with
 * NO network term, unlike the network-aware gates regtest activates from
 * genesis. So `network: 'regtest'` does not turn them on; only the block time
 * does. The simulator used to default to 1700000000 (2023-11-14), well below
 * the ratified 2026-08-07 flag-day, which made `new Uint8Array(100000)` cost
 * 225 gas locally and 100228 gas on chain.
 *
 * Two layers, and the second is the one that can actually go red for the right
 * reason: (1) an arithmetic pin, so a future flag-day dated LATER than the
 * default reddens here instead of silently stranding the simulator below it;
 * and (2) an executed gas comparison, which returns a zero delta -- and fails --
 * if the default ever drops back below the gate.
 *
 * Needs the isolated-vm binding, so the require is guarded exactly as
 * simulator.test.js guards it: the suite SKIPS on a host where it cannot dlopen
 * (macOS dev box) and runs for real on Node 22 / Linux (CI).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
let DEFAULT_BLOCK_TIME = null;
let XChainVM = null;
try {
    ({ ContractSimulator, DEFAULT_BLOCK_TIME } = require('../../src/toolkit/simulator.js'));
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping simulator block-time tests (isolated-vm unavailable):', e.message);
}

// Allocates a large typed array: unmetered below the binary-alloc flag-day,
// charged at byte length at/after it. The state write keeps the call from being
// optimized into nothing.
const ALLOC = `
module.exports = {
    alloc: function (xchain) {
        var buf = new Uint8Array(100000);
        xchain.state.set('n', String(buf.length));
        return String(buf.length);
    }
};
`;

const PRE_GATE_TIME = 1700000000;   // the old default: 2023-11-14, below every gate

(ContractSimulator ? describe : describe.skip)('toolkit: simulator default block time', function () {
    this.timeout(30000);

    it('exposes a default at/after every exported *_GATE_BLOCK_TIME', function () {
        const gates = Object.keys(XChainVM)
            .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && Number.isFinite(XChainVM[k]));

        assert.ok(gates.length > 0,
            'the VM stopped exporting *_GATE_BLOCK_TIME constants; the simulator default ' +
            'can no longer be derived from them and has fallen back to a literal');

        for (const name of gates) {
            assert.ok(DEFAULT_BLOCK_TIME >= XChainVM[name],
                'simulator DEFAULT_BLOCK_TIME (' + DEFAULT_BLOCK_TIME + ') is below ' + name +
                ' (' + XChainVM[name] + '): every default simulation would meter under the ' +
                'pre-activation rule set for that gate and under-report gas. Move the default ' +
                'forward in the same change that dates the new flag-day.');
        }
    });

    it('seeds a default-constructed simulator with that block time', function () {
        const sim = new ContractSimulator();
        assert.strictEqual(sim.block.timestamp, DEFAULT_BLOCK_TIME);
    });

    it('still honours an explicit pre-flag-day block override', function () {
        const sim = new ContractSimulator({ block: { timestamp: PRE_GATE_TIME } });
        assert.strictEqual(sim.block.timestamp, PRE_GATE_TIME);
        assert.strictEqual(sim.block.height, 1, 'the un-overridden fields keep their defaults');
    });

    it('charges live-chain gas for a large allocation by default', async function () {
        const dflt = new ContractSimulator();
        const pre  = new ContractSimulator({ block: { timestamp: PRE_GATE_TIME } });
        try {
            const a = await dflt.deploy(ALLOC);
            const b = await pre.deploy(ALLOC);
            const rDefault = await dflt.call(a.contractIndex, 'alloc', []);
            const rPreGate = await pre.call(b.contractIndex, 'alloc', []);

            assert.ok(rDefault.success, 'default-block alloc failed: ' + rDefault.error);
            assert.ok(rPreGate.success, 'pre-gate alloc failed: ' + rPreGate.error);

            // The byte-length charge is 1 gas per allocated byte, so the delta is
            // ~100000. Assert an order of magnitude rather than the exact number so
            // an unrelated metering tweak does not make this brittle; a default that
            // slipped back below the gate returns a delta of exactly 0.
            assert.ok(rDefault.gasUsed - rPreGate.gasUsed > 50000,
                'default simulator charged ' + rDefault.gasUsed + ' gas for a 100000-byte ' +
                'allocation and the pre-flag-day simulator charged ' + rPreGate.gasUsed + '. ' +
                'A small or zero delta means the default block time is below the binary-alloc ' +
                'gate, so simulated gas is a pre-activation number no live chain charges.');
        } finally {
            await dflt.close();
            await pre.close();
        }
    });

    it('warns once, and only below the flag-day', async function () {
        const seen = [];
        const real = console.warn;
        console.warn = (...args) => seen.push(args.join(' '));
        const quiet = new ContractSimulator();
        const loud  = new ContractSimulator({ block: { timestamp: PRE_GATE_TIME } });
        try {
            const q = await quiet.deploy(ALLOC);
            await quiet.call(q.contractIndex, 'alloc', []);
            assert.strictEqual(seen.length, 0, 'default simulator must not warn: ' + seen.join(' | '));

            const l = await loud.deploy(ALLOC);
            await loud.call(l.contractIndex, 'alloc', []);
            await loud.call(l.contractIndex, 'alloc', []);
            assert.strictEqual(seen.length, 1, 'pre-gate simulator must warn exactly once per ' +
                'instance, got ' + seen.length);
            assert.ok(/predates the VM metering flag-day/.test(seen[0]), 'unexpected warning: ' + seen[0]);
        } finally {
            console.warn = real;
            await quiet.close();
            await loud.close();
        }
    });
});
