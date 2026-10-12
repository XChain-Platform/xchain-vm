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
 * Toolkit: the E2E harness (test/e2e/helpers/harness.js) must open on the
 * chain position the simulator anchors on, and charge the simulator's fees.
 *
 * Every xchain-vm e2e suite and every xchain-contracts template suite deploys
 * through that harness, so a harness left on a pre-flag-day block time, a
 * height below the armed height gates, or no network at all tests templates
 * under a rule set mainnet no longer runs, with nothing going red. This file is
 * the tripwire: when a new flag day elapses, liveBlockTime() moves and the
 * harness must move with it.
 *
 * Needs the isolated-vm binding; the require is guarded so the suite SKIPS on a
 * host where it cannot load, as the simulator tests do.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let XChainVM = null, sim = null, gates = null, harness = null, HEIGHT_GATES = null;
try {
    XChainVM = require('../../src/index.js');
    sim      = require('../../src/toolkit/simulator.js');
    gates    = require('../../src/toolkit/simulator/block_time_gates.js');
    ({ HEIGHT_GATES } = require('../../src/toolkit/simulator/constants.js'));
    harness  = require('../e2e/helpers/harness.js');
} catch (e) {
    console.log('Skipping E2E harness parity tests (isolated-vm unavailable):', e.message);
}

// Gate constants at or above this are unarmed placeholders, not ratified flag days.
const UNARMED_SENTINEL = 9999999999;

// Every armed *_GATE_BLOCK_TIME the VM exports, by name.
function armedGateNames() {
    return Object.keys(XChainVM)
        .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && Number.isFinite(XChainVM[k]))
        .filter((k) => XChainVM[k] < UNARMED_SENTINEL);
}

// Source that only the execute-time re-lint refuses once it is stored unlinted.
const RANDOM_PROBE = `module.exports = {
    tryRandom: function (xchain) { return typeof Math.random; }
};`;

async function runStoredProbe(h) {
    h.seedBalance('caller', 'XCHAIN', '1000000');
    h.ledger.deployContract('C:BTC:1', RANDOM_PROBE, 'caller', h.ledger.blockHeight);
    return h.execute({ contractAddress: 'C:BTC:1', method: 'tryRandom', params: [], caller: 'caller' });
}

(harness ? describe : describe.skip)('toolkit: E2E harness anchor parity', function () {
    this.timeout(30000);

    it('opens at the live block time: at/after every elapsed gate, below every scheduled one', function () {
        const ts = new harness.E2EHarness(XChainVM).ledger.getBlockContext().timestamp;
        assert.strictEqual(ts, gates.liveBlockTime(undefined, 'mainnet'),
            'harness block time is not the mainnet liveBlockTime()');
        const now = Math.floor(Date.now() / 1000);
        let elapsedSeen = 0;
        for (const name of armedGateNames()) {
            const t = XChainVM[name];
            if (t <= now) elapsedSeen += 1;
            assert.ok(t <= now ? ts >= t : ts < t,
                'harness block time ' + ts + ' is on the wrong side of ' + name + ' (' + t + ')');
        }
        assert.ok(elapsedSeen > 0, 'no gate has elapsed, so this assertion proves nothing');
    });

    it('opens on BTC mainnet at a height every armed height gate is active at', function () {
        const h = new harness.E2EHarness(XChainVM);
        const height = h.ledger.getBlockContext().height;
        assert.strictEqual(h.network, 'mainnet');
        assert.strictEqual(height, gates.defaultBlockHeight('BTC', 'mainnet'));
        const armed = HEIGHT_GATES.filter((g) => gates.heightGateNeed(g, 'BTC', 'mainnet') !== undefined);
        assert.ok(armed.length > 0, 'no height gate is armed on BTC mainnet, so this proves nothing');
        for (const g of armed)
            assert.strictEqual(XChainVM[g.isActive]('mainnet', 'BTC', height), true, g.label + ' is off');
    });

    it('returns to the same start position on reset()', function () {
        const h = new harness.E2EHarness(XChainVM);
        const start = h.ledger.getBlockContext();
        h.mineBlock(); h.mineBlock();
        h.reset();
        assert.deepStrictEqual(h.ledger.getBlockContext(), start);
    });

    it('forwards the network to execute: stored unlinted source is refused only with one', async function () {
        const live = await runStoredProbe(new harness.E2EHarness(XChainVM));
        assert.strictEqual(live.success, false, 'mainnet execute-time re-lint did not run');
        const bare = await runStoredProbe(new harness.E2EHarness(XChainVM, { network: null }));
        assert.strictEqual(bare.success, true, 'the no-network opt-out should skip the re-lint: ' + bare.error);
    });

    it('charges the simulator schedule itself and its limits apart from the wall budget', function () {
        assert.strictEqual(harness.GAS_SCHEDULE, sim.DEFAULT_GAS_SCHEDULE,
            'the harness carries its own gas schedule again instead of the simulator\'s');
        assert.deepStrictEqual(
            { ...harness.DEFAULT_LIMITS, maxCpuTimeMs: sim.DEFAULT_LIMITS.maxCpuTimeMs },
            { ...sim.DEFAULT_LIMITS });
        assert.strictEqual(harness.DEFAULT_LIMITS.maxCpuTimeMs, harness.E2E_MAX_CPU_TIME_MS);
    });
});
