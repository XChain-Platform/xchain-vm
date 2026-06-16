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
// Unit tests for src/readonly-accessors.js — turns plain serializable snapshots
// (the out-of-process contract) into the synchronous accessor objects the gateway
// expects, with backward-compatible passthrough of legacy accessor objects.

const assert = require('assert');
const {
    buildOracleAccessor,
    buildContractStakeAccessor,
    buildCrossChainAccessor,
    buildAttestationAccessor,
    resolveAccessors,
} = require('../../src/readonly-accessors.js');

describe('Read-only accessors', function () {

    describe('buildOracleAccessor', function () {
        it('returns null for a null snapshot', function () {
            assert.strictEqual(buildOracleAccessor(null), null);
            assert.strictEqual(buildOracleAccessor(undefined), null);
        });
        it('passes a legacy accessor object through unchanged', function () {
            const legacy = { getPrice: () => '1', getPriceAtRound: () => '2', getSnapshotAge: () => 0 };
            assert.strictEqual(buildOracleAccessor(legacy), legacy);
        });
        it('builds getPrice from a snapshot (present and absent)', function () {
            const a = buildOracleAccessor({ prices: { 'BTC/USD': '60000' }, snapshotAge: 4 });
            assert.strictEqual(a.getPrice('BTC/USD'), '60000');
            assert.strictEqual(a.getPrice('LTC/USD'), null);
        });
        it('builds getPriceAtRound (no pair, missing round, present)', function () {
            const a = buildOracleAccessor({ rounds: { 'BTC/USD': { '5': '59000' } } });
            assert.strictEqual(a.getPriceAtRound('BTC/USD', 5), '59000');
            assert.strictEqual(a.getPriceAtRound('BTC/USD', 6), null);
            assert.strictEqual(a.getPriceAtRound('LTC/USD', 5), null);
        });
        it('getSnapshotAge uses the snapshot value or MAX_SAFE_INTEGER', function () {
            assert.strictEqual(buildOracleAccessor({ snapshotAge: 9 }).getSnapshotAge(), 9);
            assert.strictEqual(buildOracleAccessor({}).getSnapshotAge(), Number.MAX_SAFE_INTEGER);
        });
    });

    describe('buildContractStakeAccessor', function () {
        it('returns null for a null snapshot', function () {
            assert.strictEqual(buildContractStakeAccessor(null), null);
        });
        it('passes a legacy accessor object through unchanged', function () {
            const legacy = { getStake: () => '0', getTotalStaked: () => '0', getStakers: () => [] };
            assert.strictEqual(buildContractStakeAccessor(legacy), legacy);
        });
        it('getStake lowercases the pubkey and falls back to 0', function () {
            const a = buildContractStakeAccessor({ stakeByPubkeyTick: { 'abc|TOK': '42' } });
            assert.strictEqual(a.getStake('ABC', 'TOK'), '42');
            assert.strictEqual(a.getStake('zzz', 'TOK'), '0');
            assert.strictEqual(a.getStake(null, null), '0');
        });
        it('getTotalStaked and getStakers read by tick with safe defaults', function () {
            const a = buildContractStakeAccessor({
                totalByTick: { TOK: '100' },
                stakersByTick: { TOK: [{ pubkey: 'p', amount: '100' }] },
            });
            assert.strictEqual(a.getTotalStaked('TOK'), '100');
            assert.strictEqual(a.getTotalStaked('NONE'), '0');
            assert.deepStrictEqual(a.getStakers('TOK'), [{ pubkey: 'p', amount: '100' }]);
            assert.deepStrictEqual(a.getStakers('NONE'), []);
        });
        it('getStakers returns [] when the stored value is not an array', function () {
            const a = buildContractStakeAccessor({ stakersByTick: { TOK: 'oops' } });
            assert.deepStrictEqual(a.getStakers('TOK'), []);
        });
    });

    describe('buildCrossChainAccessor', function () {
        it('returns null for a null snapshot', function () {
            assert.strictEqual(buildCrossChainAccessor(null), null);
        });
        it('passes a legacy accessor object through unchanged', function () {
            const legacy = { getAttestation: () => null, isSettled: () => false };
            assert.strictEqual(buildCrossChainAccessor(legacy), legacy);
        });
        it('getAttestation keys on chain:index (present and absent)', function () {
            const a = buildCrossChainAccessor({ attestations: { 'LTC:9': 'v' }, settled: { 'LTC:9': true } });
            assert.strictEqual(a.getAttestation('LTC', 9), 'v');
            assert.strictEqual(a.getAttestation('LTC', 10), null);
            assert.strictEqual(a.isSettled('LTC', 9), true);
            assert.strictEqual(a.isSettled('LTC', 10), false);
        });
    });

    describe('buildAttestationAccessor', function () {
        it('returns null for a null snapshot', function () {
            assert.strictEqual(buildAttestationAccessor(null), null);
        });
        it('passes a legacy accessor object through unchanged', function () {
            const legacy = { getResponse: () => null };
            assert.strictEqual(buildAttestationAccessor(legacy), legacy);
        });
        it('getResponse returns the value, null for unknown, null for non-string id', function () {
            const a = buildAttestationAccessor({ responses: { rid: { ok: true } } });
            assert.deepStrictEqual(a.getResponse('rid'), { ok: true });
            assert.strictEqual(a.getResponse('nope'), null);
            assert.strictEqual(a.getResponse(123), null);
        });
    });

    describe('empty-snapshot fallbacks (|| {} / || \'\' default branches)', function () {
        it('oracle accessor copes with an empty snapshot', function () {
            const a = buildOracleAccessor({});
            assert.strictEqual(a.getPrice('BTC/USD'), null);
            assert.strictEqual(a.getPriceAtRound('BTC/USD', 1), null);
            assert.strictEqual(a.getSnapshotAge(), Number.MAX_SAFE_INTEGER);
        });
        it('contract-stake accessor copes with an empty snapshot and falsy token', function () {
            const a = buildContractStakeAccessor({});
            assert.strictEqual(a.getTotalStaked(null), '0');
            assert.deepStrictEqual(a.getStakers(undefined), []);
            assert.strictEqual(a.getStake(undefined, undefined), '0');
        });
        it('cross-chain accessor copes with an empty snapshot', function () {
            const a = buildCrossChainAccessor({});
            assert.strictEqual(a.getAttestation('LTC', 1), null);
            assert.strictEqual(a.isSettled('LTC', 1), false);
        });
        it('attestation accessor copes with an empty snapshot', function () {
            const a = buildAttestationAccessor({});
            assert.strictEqual(a.getResponse('rid'), null);
        });
    });

    describe('resolveAccessors', function () {
        it('resolves all four fields, mixing snapshots and nulls', function () {
            const r = resolveAccessors({
                oracleData: { prices: { 'BTC/USD': '1' } },
                crossChainData: null,
                attestationData: { responses: {} },
                contractStakeData: { totalByTick: { T: '5' } },
            });
            assert.strictEqual(r.oracleData.getPrice('BTC/USD'), '1');
            assert.strictEqual(r.crossChainData, null);
            assert.strictEqual(r.attestationData.getResponse('x'), null);
            assert.strictEqual(r.contractStakeData.getTotalStaked('T'), '5');
        });
    });
});
