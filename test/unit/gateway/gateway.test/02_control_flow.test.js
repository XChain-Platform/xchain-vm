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
const { ContractRevertError } = require('../../../../src/errors.js');
const {
    SCHEDULE, mkGas, mkState, mkCollector, baseReadOnly, build, buildGateway,
} = require('./helpers/gateway.js');

describe('Gateway (host-function surface)', function () {
    describe('control flow', function () {
        it('revert throws ContractRevertError and records the reason', function () {
            const { gw, execContext } = build();
            assert.throws(() => gw.revert('nope'), (e) => e instanceof ContractRevertError && /nope/.test(e.message));
            assert.strictEqual(execContext.reverted, true);
            assert.strictEqual(execContext.revertReason, 'nope');
        });
        it('revert defaults the reason and tolerates a missing execContext', function () {
            assert.throws(() => build().gw.revert(), /reverted/);
            const gw = buildGateway(mkGas(), mkState(), mkCollector(), baseReadOnly(), SCHEDULE, undefined);
            assert.throws(() => gw.revert('x'), ContractRevertError);
        });
        it('require passes a true condition and throws on false', function () {
            const { gw, execContext } = build();
            assert.doesNotThrow(() => gw.require(true, 'ok'));
            assert.throws(() => gw.require(false, 'bad'), (e) => e instanceof ContractRevertError && /bad/.test(e.message));
            assert.strictEqual(execContext.revertReason, 'bad');
        });
        it('require defaults the reason and tolerates a missing execContext', function () {
            assert.throws(() => build().gw.require(false), /requirement failed/);
            const gw = buildGateway(mkGas(), mkState(), mkCollector(), baseReadOnly(), SCHEDULE, undefined);
            assert.throws(() => gw.require(0, 'x'), ContractRevertError);
        });
    });
});
