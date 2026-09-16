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

const assert = require('assert');
const { SCHEDULE, build } = require('./helpers/gateway.js');

const PUB = 'a'.repeat(64);

describe('Gateway (host-function surface)', function () {
    describe('contract.slash', function () {
        it('emits a SLASH carrying the contractIndex and charges an emission', function () {
            const { gw, gas, collector } = build();
            gw.contract.slash(PUB, 'TOK', '10.5');
            assert.strictEqual(collector.actions.length, 1);
            assert.deepStrictEqual(collector.actions[0], {
                action: 'SLASH',
                params: { contractIndex: 7, pubkey: PUB, token: 'TOK', amount: '10.5' },
            });
            assert.ok(gas.charges.includes(SCHEDULE.VM_EMISSION));
        });
        it('rejects bad pubkey, token, and amount', function () {
            const { gw } = build();
            assert.throws(() => gw.contract.slash('short', 'TOK', '1'), /pubkey must be a 64-hex string/);
            assert.throws(() => gw.contract.slash(PUB, '', '1'), /token must be a non-empty string/);
            // 9 dp is the PRE-activation ceiling only; the gate-on half is pinned below.
            assert.throws(() => gw.contract.slash(PUB, 'TOK', '1.123456789'), /amount must be a positive decimal/);
            assert.throws(() => gw.contract.slash(PUB, 'TOK', 'abc'), /amount must be a positive decimal/);
        });
    });
});

describe('Gateway (host-function surface)', function () {
    describe('contract.slash', function () {
        // The stake path admits each token's DECIMALS up to MAX_TOKEN_DECIMALS 18,
        // and slashContractStake deducts at that precision. Expanding contract.slash
        // from 8 to 18 decimal places is consensus-visible, so the host gates it and
        // both activation states are pinned here.
        it('accepts up to 18 fractional digits when the precision gate is on', function () {
            const { gw, collector } = build({ slashAmountPrecisionOn: true });
            gw.contract.slash(PUB, 'TOK', '100.123456789012345678');
            assert.strictEqual(collector.actions.length, 1);
            assert.strictEqual(collector.actions[0].params.amount, '100.123456789012345678',
                'the amount must reach the emission byte-identical, never re-rounded');
            // 19 dp is past the token ceiling and stays rejected on both sides.
            assert.throws(() => gw.contract.slash(PUB, 'TOK', '1.1234567890123456789'),
                /amount must be a positive decimal/);
        });

        it('keeps the 8-dp ceiling below the precision gate (replay parity)', function () {
            const { gw, collector } = build({ slashAmountPrecisionOn: false });
            assert.throws(() => gw.contract.slash(PUB, 'TOK', '100.123456789012345678'),
                /amount must be a positive decimal/);
            assert.strictEqual(collector.actions.length, 0, 'a rejected slash must emit nothing');
            gw.contract.slash(PUB, 'TOK', '100.12345678');
            assert.strictEqual(collector.actions[0].params.amount, '100.12345678');
        });

        // The '|' guard changes consensus-visible acceptance, so the host gates it
        // and both activation states are pinned here.
        it('rejects a token carrying the wire delimiter when the gate is on', function () {
            const { gw, collector } = build({ slashTokenDelimGuardOn: true });
            assert.throws(() => gw.contract.slash(PUB, 'TO|K', '1'), /token must not contain "\|"/);
            assert.throws(() => gw.contract.slash(PUB, '|', '1'), /token must not contain "\|"/);
            assert.throws(() => gw.contract.slash(PUB, 'TOK|', '1'), /token must not contain "\|"/);
            assert.strictEqual(collector.actions.length, 0, 'a rejected slash must emit nothing');
            // A delimiter-free token is unaffected by the gate.
            gw.contract.slash(PUB, 'TOK', '1');
            assert.strictEqual(collector.actions.length, 1);
            assert.strictEqual(collector.actions[0].params.token, 'TOK');
        });

        it('emits a delimiter-bearing token unchanged below the gate (replay parity)', function () {
            const { gw, collector } = build({ slashTokenDelimGuardOn: false });
            gw.contract.slash(PUB, 'TO|K', '1');
            assert.deepStrictEqual(collector.actions[0], {
                action: 'SLASH',
                params: { contractIndex: 7, pubkey: PUB, token: 'TO|K', amount: '1' },
            });
        });

        it('charges the emission before the delimiter check (anti-spam ordering)', function () {
            const { gw, gas } = build({ slashTokenDelimGuardOn: true });
            assert.throws(() => gw.contract.slash(PUB, 'TO|K', '1'), /must not contain/);
            assert.ok(gas.charges.includes(SCHEDULE.VM_EMISSION),
                'a rejected slash still costs the emission charge, like the other validators');
        });
    });
});
