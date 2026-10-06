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
 * Toolkit: the simulator's DEFAULT block time must also clear the configured
 * network's own per-network block-TIME gates, not only the scalar
 * *_GATE_BLOCK_TIME ones. Testnet armed JSON_STRINGIFY_HOOK_ACTIVATION and
 * CONTRACT_META_REQUIRED at instants later than the newest scalar gate, so a
 * default testnet simulator anchored on the scalars alone ran with both rules
 * OFF while live testnet runs them ON: a different gasUsed and result for a
 * hook-bearing value, and a deploy verdict testnet does not give.
 *
 * Needs the isolated-vm binding for the executed cases; the suite skips
 * where it cannot load, exactly as simulator_block_time.test.js does.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');

let ContractSimulator = null;
let liveBlockTime = null;
let XChainVM = null;
let TIME_NETWORK_GATES = null;
try {
    ({ ContractSimulator, liveBlockTime } = require('../../src/toolkit/simulator.js'));
    ({ TIME_NETWORK_GATES } = require('../../src/toolkit/simulator/constants.js'));
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping simulator network block-time tests (isolated-vm unavailable):', e.message);
}

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const UNARMED_SENTINEL = 9999999999;
const NOW = () => Math.floor(Date.now() / 1000);
const armed = (t) => Number.isFinite(t) && t > 0 && t < UNARMED_SENTINEL;

// A toJSON hook that hands the serializer a spine one level past the depth guard:
// with the hook gate ON it faults out_of_stack, with it OFF it serializes.
const HOOK_SPINE = (depth) => `module.exports = {
    meta: { name: 'Hook probe', description: 'Serializes a toJSON-produced spine' },
    run: function (xchain) {
        var spine = [];
        for (var i = 0; i < ${depth}; i++) { spine = [spine]; }
        return String(JSON.stringify({ toJSON: function () { return spine; } }).length);
    }
};`;

// Run one call quietly and return the parts a chain would commit.
async function runQuiet(opts, src, method) {
    const real = console.warn;
    console.warn = () => {};
    const sim = new ContractSimulator(opts);
    try {
        const d = await sim.deploy(src);
        const r = await sim.call(d.contractIndex, method, []);
        return { success: r.success, error: r.error, returnValue: r.returnValue, gasUsed: r.gasUsed };
    } finally { console.warn = real; await sim.close(); }
}

(ContractSimulator ? describe : describe.skip)('toolkit: simulator per-network default block time', function () {
    this.timeout(30000);

    it('lists every VM network-keyed block-time map in TIME_NETWORK_GATES', function () {
        // Height maps stay far below 1e9; any bare-network map holding a time-sized
        // value is a time gate the live anchor must fold in, or this goes red.
        const timeMaps = Object.keys(XChainVM).filter((k) => {
            const v = XChainVM[k];
            if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
            const keys = Object.keys(v);
            return keys.length > 0 && keys.every((n) => NETWORKS.includes(n)) &&
                keys.some((n) => Number.isFinite(v[n]) && v[n] >= 1e9);
        });
        assert.ok(timeMaps.includes('JSON_STRINGIFY_HOOK_ACTIVATION'), 'the enumeration found nothing to check');
        const named = TIME_NETWORK_GATES.map((g) => g.source);
        for (const k of timeMaps) assert.ok(named.includes(k), k + ' is missing from TIME_NETWORK_GATES');
    });

    it('folds a network gate into the live anchor exactly at its instant', function () {
        let checked = 0;
        for (const network of NETWORKS) {
            for (const g of TIME_NETWORK_GATES) {
                const t = g.resolve(network);
                if (!armed(t)) continue;
                checked += 1;
                assert.ok(liveBlockTime(t, network) >= t, g.label + ' on ' + network + ' is off at its own instant');
                if (t > liveBlockTime(t)) {
                    assert.ok(liveBlockTime(t - 1, network) < t, g.label + ' on ' + network + ' is on a second early');
                }
            }
        }
        assert.ok(checked > 0, 'no armed per-network gate was checked');
        assert.strictEqual(liveBlockTime(NOW()), liveBlockTime(NOW(), undefined),
            'with no network the live anchor must stay the network-agnostic one');
    });

    it('defaults each network onto its elapsed gates and onto no future scalar one', function () {
        const now = NOW();
        for (const network of NETWORKS) {
            const ts = new ContractSimulator({ network }).block.timestamp;
            for (const g of TIME_NETWORK_GATES) {
                const t = g.resolve(network);
                if (armed(t) && t <= now) assert.ok(ts >= t, g.label + ' is OFF in a default ' + network + ' simulator');
            }
            assert.strictEqual(XChainVM.isRestPatternMeterActive(network, ts), XChainVM.isRestPatternMeterActive(network, now),
                'a default ' + network + ' simulator must resolve the rest-pattern gate as the live chain does');
        }
    });
});

(ContractSimulator ? describe : describe.skip)('toolkit: simulator per-network default block time', function () {
    this.timeout(60000);

    it('runs the testnet JSON.stringify hook rule the live testnet runs', async function () {
        const hookAt = XChainVM.jsonStringifyHookGateTime('testnet');
        if (!armed(hookAt) || hookAt > NOW()) this.skip();
        const src = HOOK_SPINE(XChainVM.MAX_STACK_DEPTH_MUSL || 256);
        const dflt = await runQuiet({ network: 'testnet' }, src, 'run');
        const live = await runQuiet({ network: 'testnet', block: { timestamp: hookAt } }, src, 'run');
        const before = await runQuiet({ network: 'testnet', block: { timestamp: hookAt - 1 } }, src, 'run');
        // Teeth: the probe must actually tell the two sides of the gate apart.
        assert.notDeepStrictEqual(live, before, 'the probe no longer distinguishes the hook gate');
        assert.deepStrictEqual(dflt, live, 'a default testnet simulator ran without the live hook gate');
    });

    it('refuses a meta-less deploy on default testnet, as live testnet does', async function () {
        const metaAt = TIME_NETWORK_GATES.find((g) => g.source === 'CONTRACT_META_REQUIRED_TIMES').resolve('testnet');
        if (!armed(metaAt) || metaAt > NOW()) this.skip();
        const real = console.warn;
        console.warn = () => {};
        const sim = new ContractSimulator({ network: 'testnet' });
        try {
            const d = await sim.deploy('module.exports = function () { return 1; };');
            assert.strictEqual(d.deployGate.valid, false, 'testnet requires meta, so the default verdict must refuse');
        } finally { console.warn = real; await sim.close(); }
    });

    // Pinned at the network-agnostic anchor, which testnet has already passed.
    it('warns once at the scalar-only anchor on testnet and stays quiet on the default', async function () {
        const scalarOnly = liveBlockTime(NOW());
        if (new ContractSimulator({ network: 'testnet' }).block.timestamp <= scalarOnly) this.skip();
        const seen = [];
        const real = console.warn;
        console.warn = (...args) => seen.push(args.join(' '));
        const quiet = new ContractSimulator({ network: 'testnet' });
        const loud = new ContractSimulator({ network: 'testnet', block: { timestamp: scalarOnly } });
        const src = 'module.exports = { meta: { name: "Two", description: "Returns two" }, run: function () { return 2; } };';
        try {
            const q = await quiet.deploy(src);
            await quiet.call(q.contractIndex, 'run', []);
            assert.strictEqual(seen.length, 0, 'default testnet simulator must not warn: ' + seen.join(' | '));
            const l = await loud.deploy(src);
            await loud.call(l.contractIndex, 'run', []);
            await loud.call(l.contractIndex, 'run', []);
            assert.strictEqual(seen.filter((w) => /predates the VM metering flag-day/.test(w)).length, 1, seen.join(' | '));
        } finally { console.warn = real; await quiet.close(); await loud.close(); }
    });
});
