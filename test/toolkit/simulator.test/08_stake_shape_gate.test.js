/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Toolkit: the stake read shape a node delivers. The simulator serves seeded
 * stake amounts as decimal strings and warns once where a node at the same
 * network, block time and path hands a contract mathjs JSON objects instead.
 * The mirrored activation rows are compared against the sibling xchain-indexer
 * registry rows; those cases skip when the sibling is absent, except under
 * XCHAIN_REQUIRE_SIBLINGS=1, where they fail.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const path = require('path');

const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const shapeGate = require('../../../src/toolkit/simulator/stake_shape_gate.js');

let ContractSimulator = null;
try {
    ({ ContractSimulator } = require('../../../src/toolkit/simulator.js'));
} catch (e) {
    console.log('Skipping toolkit simulator tests (isolated-vm unavailable):', e.message);
}

const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENV = shapeGate.GUARD_REGTEST_TIME_ENV;
const CALL_ROW = 'STAKE_SNAPSHOT_DECIMAL_STRINGS';
const GUARD_ROW = 'GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS';
const PK = 'a'.repeat(64);
const READER = `
module.exports = {
    meta: { name: 'Stake shape probe', description: 'Reads seeded stakes' },
    default: function(xchain) {
        return JSON.stringify([xchain.contract.getStake('${PK}', 'GOLD'),
            xchain.contract.getTotalStaked('GOLD'), xchain.contract.getStakers('GOLD')[0].amount]);
    },
    guard: function(xchain) { return 'ok'; }
};`;

// Runs fn (sync or async) with the regtest guard override set to value (undefined clears it).
async function withGuardEnv(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, ENV);
    const prior = process.env[ENV];
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    try { return await fn(); } finally {
        if (had) process.env[ENV] = prior; else delete process.env[ENV];
    }
}

// Seeds one stake, runs a call or a callGuard, and returns the stake-shape warnings plus the call's read.
async function shapeWarnings(network, { guard = false, seed = true, blockTime } = {}) {
    const sim = new ContractSimulator({ network });
    if (blockTime !== undefined) sim.setBlock({ timestamp: blockTime });
    const lines = [];
    const real = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    let read = null;
    try {
        const dep = await sim.deploy(READER);
        if (seed) sim.setStake(PK, 'GOLD', '400');
        for (let i = 0; i < 2; i++) {
            if (guard) await sim.callGuard(dep.contractIndex, { actionType: 'SEND' });
            else if (seed) read = JSON.parse(JSON.parse((await sim.call(dep.contractIndex)).returnValue));
            else await sim.call(dep.contractIndex, 'guard');
        }
    } finally { console.warn = real; await sim.close(); }
    return { warned: lines.filter((l) => l.includes('stake amounts read back here')), read };
}

// The indexer registry row's per-network instants, with its UNARMED sentinel read as null.
function indexerRow(changes, unarmed, name) {
    const row = changes.find((r) => r[0] === name);
    assert.ok(row, name + ' row not found in changes_5.js; re-point this pin');
    const norm = (t) => (t === unarmed ? null : t);
    const regtest = typeof row[4] === 'function' ? row[4]() : row[4];
    return { mainnet: norm(row[2]), testnet: norm(row[3]), regtest: norm(regtest) };
}

describe('Toolkit stake shape rows agree with the indexer registry', function() {
    let changes = null;
    let unarmed = null;

    beforeEach(function() {
        const rel = path.join('xchain-indexer', 'src', 'protocol_changes', 'changes_5.js');
        const verdict = siblingCheckout(__dirname, path.join(PLATFORM_ROOT, rel));
        if (!skipOrFail(this, verdict, 'stake shape row parity (' + rel + ')')) return;
        changes = require(verdict.path);
        unarmed = require(path.join(path.dirname(verdict.path), 'core.js')).UNARMED;
    });

    it('mirrors the call-path row on every network', function() {
        const mirror = {};
        for (const n of ['mainnet', 'testnet', 'regtest']) mirror[n] = shapeGate.stakeDecimalStringsTime(n, false);
        assert.deepStrictEqual(mirror, indexerRow(changes, unarmed, CALL_ROW));
    });

    it('mirrors the guard-path row, regtest override unset, zero and positive', async function() {
        for (const value of [undefined, '0', '', 'off', '1800000000']) {
            await withGuardEnv(value, () => {
                const mirror = {};
                for (const n of ['mainnet', 'testnet', 'regtest']) mirror[n] = shapeGate.stakeDecimalStringsTime(n, true);
                assert.deepStrictEqual(mirror, indexerRow(changes, unarmed, GUARD_ROW), 'override ' + value);
            });
        }
    });
});

describe('Toolkit stake shape activation', function() {
    it('compares time rows as ProtocolChanges.isEnabled does', async function() {
        const at = shapeGate.STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES.testnet;
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('testnet', at - 1, false), false);
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('testnet', at, false), true);
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('regtest', 1, false), true);
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('mainnet', 4102444800, false), false);
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('signet', 4102444800, false), false);
        assert.strictEqual(shapeGate.isStakeDecimalStringsActive('testnet', NaN, false), false);
        await withGuardEnv(undefined, () =>
            assert.strictEqual(shapeGate.isStakeDecimalStringsActive('regtest', 4102444800, true), false));
    });
});

(ContractSimulator ? describe : describe.skip)('Toolkit ContractSimulator: stake read shape warning', function() {
    this.timeout(30000);

    it('warns once on a mainnet call that reads seeded stakes, and still serves strings', async function() {
        const { warned, read } = await shapeWarnings('mainnet');
        assert.strictEqual(warned.length, 1, JSON.stringify(warned));
        assert.ok(warned[0].includes(CALL_ROW + ' is unarmed on "mainnet"'), warned[0]);
        assert.deepStrictEqual(read, ['400', '400', '400']);
    });

    it('stays silent on a mainnet call with no seeded stakes', async function() {
        const { warned } = await shapeWarnings('mainnet', { seed: false });
        assert.deepStrictEqual(warned, []);
    });

    it('stays silent on a regtest call, where the call-path row is on from genesis', async function() {
        const { warned } = await shapeWarnings('regtest');
        assert.deepStrictEqual(warned, []);
    });

    it('warns on a regtest callGuard unless the guard override arms the row', async function() {
        const off = await withGuardEnv(undefined, () => shapeWarnings('regtest', { guard: true }));
        assert.strictEqual(off.warned.length, 1, JSON.stringify(off.warned));
        assert.ok(off.warned[0].includes(GUARD_ROW + ' is unarmed') && off.warned[0].includes('controller-guard'));
        const on = await withGuardEnv('1', () => shapeWarnings('regtest', { guard: true }));
        assert.deepStrictEqual(on.warned, []);
    });

    it('splits the paths on testnet between the call and guard instants', async function() {
        const blockTime = shapeGate.STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES.testnet + 60;
        assert.deepStrictEqual((await shapeWarnings('testnet', { blockTime })).warned, []);
        const guard = await shapeWarnings('testnet', { guard: true, blockTime });
        assert.strictEqual(guard.warned.length, 1, JSON.stringify(guard.warned));
        const until = shapeGate.GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES.testnet;
        assert.ok(guard.warned[0].includes('not active until block time ' + until), guard.warned[0]);
    });
});
