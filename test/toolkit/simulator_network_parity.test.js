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
 * Toolkit: the simulator's default network is regtest, which runs
 * network-keyed gates (the iter/Set/apply meter among them) that mainnet may
 * not have armed, so a default gasUsed is not a mainnet number. These cases pin
 * that gap while it exists, read off the VM's own resolver rather than today's
 * unarmed table, and that `xchain-foundry simulate --network mainnet` closes it.
 *
 * Needs the isolated-vm binding; the suite skips where it cannot load,
 * exactly as simulator_network_block_time.test.js does.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping simulator network parity tests (isolated-vm unavailable):', e.message);
}

const XChainVM = require('../../src/index.js');

const BIN = path.join(__dirname, '../../bin/xchain-foundry.js');

// Spread a long array through Function.prototype.apply and run Set algebra: both
// are charged by the iter/Set/apply meter, which regtest runs from genesis.
const PROBE = `module.exports = {
    meta: { name: 'Network probe', description: 'Spreads a long array through apply and unions two Sets' },
    initialize: function () {},
    run: function (xchain) {
        var a = [];
        for (var i = 0; i < 5000; i++) a.push(i);
        var u = new Set(a).union(new Set([1, 2, 3]));
        return String(Math.max.apply(null, a)) + ':' + u.size;
    }
};`;

// Deploy PROBE in a fresh simulator and return the run() result.
async function runProbe(opts) {
    const sim = new ContractSimulator(Object.assign({ execution: 'in-process' }, opts));
    try {
        const dep = await sim.deploy(PROBE);
        const res = await sim.call(dep.contractIndex, 'run', []);
        res.meterOn = XChainVM.isIterSetMeterActive(sim.network, Number(sim.block.timestamp));
        return res;
    } finally {
        await sim.close();
    }
}

// Run `xchain-foundry simulate` on PROBE with extra flags.
function simulateCli(file, extra) {
    return spawnSync(process.execPath,
        [BIN, 'simulate', file, '--method', 'run', '--execution', 'in-process', ...extra],
        { encoding: 'utf8' });
}

// Parse the result object the CLI prints after its `initialize: ok` line.
function resultOf(stdout) {
    return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

// Assert regtest meters more than mainnet while mainnet's meter is off, and equally once it is on.
function assertMeterGap(regtestGas, mainnetGas, mainnetMeterOn) {
    const where = 'regtest ' + regtestGas + ', mainnet ' + mainnetGas + ', mainnet meter ' +
        (mainnetMeterOn ? 'on' : 'off');
    if (mainnetMeterOn) assert.strictEqual(regtestGas, mainnetGas, 'armed mainnet should meter as regtest does: ' + where);
    else assert.ok(regtestGas > mainnetGas, 'regtest should meter what unarmed mainnet does not: ' + where);
}

(ContractSimulator ? describe : describe.skip)('simulator network parity', function () {
    this.timeout(60000);
    let tmp;
    let file;
    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-net-'));
        file = path.join(tmp, 'probe.js');
        fs.writeFileSync(file, PROBE);
    });
    after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it('a default (regtest) simulation meters the iter/Set probe exactly when mainnet does not', async function () {
        const regtest = await runProbe({});
        const mainnet = await runProbe({ network: 'mainnet' });
        assert.strictEqual(regtest.success, true, regtest.error);
        assert.strictEqual(mainnet.success, true, mainnet.error);
        assert.strictEqual(regtest.returnValue, mainnet.returnValue);
        assert.strictEqual(regtest.meterOn, true, 'a default regtest simulator must run the iter/Set meter');
        assertMeterGap(regtest.gasUsed, mainnet.gasUsed, mainnet.meterOn);
    });

    it('simulate --network mainnet runs mainnet rules and prints the network', async function () {
        const mainnet = await runProbe({ network: 'mainnet' });
        const r = simulateCli(file, ['--network', 'mainnet']);
        assert.strictEqual(r.status, 0, r.stderr);
        const out = resultOf(r.stdout);
        assert.strictEqual(out.network, 'mainnet');
        assert.strictEqual(out.gasUsed, mainnet.gasUsed);

        const def = resultOf(simulateCli(file, []).stdout);
        assert.strictEqual(def.network, 'regtest');
        assertMeterGap(def.gasUsed, out.gasUsed, mainnet.meterOn);
    });

    it('simulate refuses an unknown --network with exit 2', function () {
        const r = simulateCli(file, ['--network', 'bogus']);
        assert.strictEqual(r.status, 2);
        assert.match(r.stderr, /--network must be mainnet, testnet or regtest/);
    });
});
