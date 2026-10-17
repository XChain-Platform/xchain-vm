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
// The wall-clock calibration probe must measure with every switched-on meter
// active. The per-network activation tables gate the iterator/Set and
// apply-length meters and the gas-ceiling success rule, so a table armed later
// than every scalar gate must move the probe block, and an armed table that is
// off at the probe block must stop the probe rather than yield a headroom figure.

'use strict';

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
const probe = require('../../determinism/helpers/probe_wall_clock_calibration.js');

const COIN = XChainVM.pkg3CoinFromAddress('C:BTC:1');

// A stand-in per-network gate armed on mainnet at `t`, resolved like the real tables.
function syntheticGate(t) {
    const table = { mainnet: t, testnet: null, regtest: 0 };
    return { name: 'synthetic-meter', source: 'SYNTHETIC_ACTIVATION', table,
        active: (network, blockTime) => Number.isFinite(table[network]) && blockTime >= table[network] };
}

describe('wall-clock calibration probe: per-network activation tables', function () {
    it('lists every bare-network activation table the VM exports', function () {
        assert.deepStrictEqual(probe.unlistedNetworkTables(), []);
        const sources = probe.NETWORK_GATES.map((g) => g.source);
        for (const s of ['ITER_SET_METER_ACTIVATION', 'APPLY_LENGTH_METER_ACTIVATION', 'GAS_CEILING_SUCCESS_ACTIVATION']) {
            assert.ok(sources.includes(s), `${s} must be a probe network gate`);
        }
    });

    it('refuses when a per-network table is missing from the list', function () {
        const without = probe.NETWORK_GATES.filter((g) => g.source !== 'ITER_SET_METER_ACTIVATION');
        assert.deepStrictEqual(probe.unlistedNetworkTables(without), ['ITER_SET_METER_ACTIVATION']);
        assert.throws(() => probe.checkNetworkGates(probe.postGateBlock(COIN), without), /ITER_SET_METER_ACTIVATION/);
    });

    it('passes on the default probe block with the shipped tables', function () {
        const block = probe.postGateBlock(COIN);
        assert.ok(Number.isFinite(block.timestamp));
        assert.ok(Array.isArray(probe.checkNetworkGates(block)));
    });

    it('folds an armed time later than every scalar gate into the probe block', function () {
        const base = probe.postGateBlock(COIN).timestamp;
        const gates = [...probe.NETWORK_GATES, syntheticGate(base + 1000)];
        const block = probe.postGateBlock(COIN, gates);
        assert.strictEqual(block.timestamp, base + 1000);
    });

    it('refuses a probe block where an armed per-network gate is off', function () {
        const stale = probe.postGateBlock(COIN);
        const gates = [...probe.NETWORK_GATES, syntheticGate(stale.timestamp + 1000)];
        assert.throws(() => probe.checkNetworkGates(stale, gates), /armed network gate synthetic-meter not active/);
        const folded = probe.postGateBlock(COIN, gates);
        assert.ok(probe.checkNetworkGates(folded, gates).includes('synthetic-meter'));
    });

    it('measures past a real armed iterator/Set meter and refuses a block before it', function () {
        const stale = probe.postGateBlock(COIN);
        const table = XChainVM.ITER_SET_METER_ACTIVATION;
        const saved = table.mainnet;
        try {
            table.mainnet = stale.timestamp + 1000;
            assert.throws(() => probe.checkNetworkGates(stale), /armed network gate iter-set-meter not active/);
            const block = probe.postGateBlock(COIN);
            assert.strictEqual(block.timestamp, stale.timestamp + 1000);
            assert.ok(probe.checkNetworkGates(block).includes('iter-set-meter'));
        } finally {
            table.mainnet = saved;
        }
    });
});

describe('wall-clock calibration probe: per-coin height tables', function () {
    it('lists every per-coin height table the VM exports', function () {
        assert.deepStrictEqual(probe.unlistedHeightTables(), []);
        const sources = probe.HEIGHT_GATES.map((g) => g.source);
        for (const s of ['GAS_CEILING_EXHAUSTED_ACTIVATION', 'JSON_STRINGIFY_REENTRY_ACTIVATION', 'HOST_ERROR_STACK_STRIP_ACTIVATION']) {
            assert.ok(sources.includes(s), `${s} must be a probe height gate`);
        }
        for (const g of probe.HEIGHT_GATES) {
            assert.ok(g.table && typeof g.table === 'object', `${g.source} must be exported`);
            assert.strictEqual(typeof g.active, 'function', `${g.name} must have an exported predicate`);
        }
    });

    it('never counts a per-network table as a per-coin height table', function () {
        const networkSources = probe.NETWORK_GATES.map((g) => g.source);
        assert.deepStrictEqual(probe.unlistedHeightTables([]).filter((k) => networkSources.includes(k)), []);
    });

    it('refuses when a per-coin height table is missing from the list', function () {
        const without = probe.HEIGHT_GATES.filter((g) => g.source !== 'GAS_CEILING_EXHAUSTED_ACTIVATION');
        assert.deepStrictEqual(probe.unlistedHeightTables(without), ['GAS_CEILING_EXHAUSTED_ACTIVATION']);
        assert.throws(() => probe.checkGates(probe.postGateBlock(COIN), COIN, without), /GAS_CEILING_EXHAUSTED_ACTIVATION/);
    });

    it('passes the height gates on the default probe block with the shipped tables', function () {
        assert.ok(Array.isArray(probe.checkGates(probe.postGateBlock(COIN), COIN)));
    });
});

describe('wall-clock calibration probe: callback Array methods', function () {
    const vectorsById = new Map(probe.VECTORS.map((vector) => [vector.id, vector]));

    for (const [id, shape] of [
        ['Sparse some loop', /new Array\(100000\).*\.some\(/],
        ['Array-like forEach loop', /\{length:100000\}.*Array\.prototype\.forEach\.call/],
        ['Sparse flatMap loop', /new Array\(100000\).*\.flatMap\(/],
    ]) {
        it(`includes the ${id} suspect vector`, function () {
            const vector = vectorsById.get(id);
            assert.ok(vector, `${id} must remain in the calibration probe`);
            assert.strictEqual(vector.group, 'unmetered-suspect');
            assert.match(vector.body, shape);
        });
    }
});

describe('wall-clock calibration probe: rebound aliases', function () {
    const vectorsById = new Map(probe.VECTORS.map((vector) => [vector.id, vector]));

    for (const [id, shape] of [
        ['String trimLeft loop', /\.trimLeft\(\)/],
        ['String trimRight loop', /\.trimRight\(\)/],
        ['Number.parseInt loop', /Number\.parseInt\(s,10\)/],
        ['Number.parseFloat loop', /Number\.parseFloat\(s\)/],
    ]) {
        it(`includes the ${id} metered vector`, function () {
            const vector = vectorsById.get(id);
            assert.ok(vector, `${id} must remain in the calibration probe`);
            assert.strictEqual(vector.group, 'metered');
            assert.match(vector.body, shape);
        });
    }
});
