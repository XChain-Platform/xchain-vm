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
// Controller-guard mode (isGuard) — the gateway must DISABLE the asynchronous
// frameworks when running a controller-bound token's `guard` method. A guard
// returns an allow/deny decision synchronously inside a native action's
// settlement, so a result that only arrives blocks later (attestation request,
// cross-chain call) is nonsensical and is rejected at emit time. Pure host-side
// gateway test — no isolated-vm — so it runs on any Node version.
//
// Spec: ../../../xchain-documentation/protocol/Controller_Bound_Tokens.md

const assert = require('assert');
const { buildGateway } = require('../../src/gateway.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function mkGas() {
    return { charges: [], charge(n) { this.charges.push(n); }, total() { return this.charges.reduce((a, b) => a + b, 0); } };
}
function mkState() {
    const m = new Map();
    return { store: m, get: (k) => m.get(k), has: (k) => m.has(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k) };
}
function mkCollector() {
    return { actions: [], logs: [], add(a, p) { this.actions.push({ action: a, params: p }); }, addLog() {}, isLogFull() { return false; }, getLogCount() { return 0; } };
}
function readOnly(isGuard) {
    return {
        caller: 'caller_addr', contractAddress: 'C:BTC:7', contractIndex: 7,
        txHash: 'a'.repeat(64), actionIndex: 1, callDepth: 0, maxCallDepth: 4, minCallGas: 5000,
        crossHops: 0, network: 'regtest', params: [], blockContext: { height: 100, timestamp: 1, hash: 'h' },
        balances: {}, tokenInfo: {}, oracleData: null, crossChainData: null, attestationData: null,
        contractStakeData: null, providerDeadlines: { llm: 20 },
        isGuard: isGuard
    };
}
function build(isGuard) {
    return buildGateway(mkGas(), mkState(), mkCollector(), readOnly(isGuard), SCHEDULE, { reverted: false });
}

const GOOD_XCALL = {
    targetChain: 'DOGE', contractIndex: 99, method: 'onArrival',
    params: [], gasLimit: 50000, callbackMethod: 'onResult', callbackParams: [], deadlineBlocks: 200
};

describe('Gateway controller-guard mode (isGuard)', function () {

    describe('guard mode (isGuard=true) disables async frameworks', function () {
        it('attestation.request throws and charges no gas', function () {
            const gw = build(true);
            assert.throws(() => gw.attestation.request('llm', 'q', 'cb', []),
                /not available to a controller guard/);
        });

        it('emit.crossExecute throws', function () {
            const gw = build(true);
            assert.throws(() => gw.emit.crossExecute(GOOD_XCALL),
                /not available to a controller guard/);
        });

        it('a synchronous emission (emit.send) still works in guard mode', function () {
            const gw = build(true);
            assert.doesNotThrow(() => gw.emit.send({ tick: 'JDOG', quantity: '1', destination: 'addr' }));
        });
    });

    describe('normal mode (isGuard=false) keeps async frameworks available', function () {
        it('attestation.request is callable', function () {
            const gw = build(false);
            assert.doesNotThrow(() => gw.attestation.request('llm', 'q', 'cb', []));
        });

        it('emit.crossExecute is callable', function () {
            const gw = build(false);
            assert.doesNotThrow(() => gw.emit.crossExecute(GOOD_XCALL));
        });
    });
});
