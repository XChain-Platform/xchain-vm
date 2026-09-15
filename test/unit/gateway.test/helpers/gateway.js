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

const { buildGateway } = require('../../../../src/gateway.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Recording fakes: let each test assert exact gas charges and captured emissions
// without depending on GasTracker/EmissionCollector internals.
function mkGas() {
    return { charges: [], charge(n) { this.charges.push(n); }, total() { return this.charges.reduce((a, b) => a + b, 0); } };
}
function mkState() {
    const m = new Map();
    return {
        store: m,
        get: (k) => m.get(k),
        has: (k) => m.has(k),
        set: (k, v) => m.set(k, v),
        delete: (k) => m.delete(k),
    };
}
function mkCollector() {
    return {
        actions: [],
        logs: [],
        logFull: false,
        add(action, params) { this.actions.push({ action, params }); },
        addLog(msg) { this.logs.push(msg); },
        isLogFull() { return this.logFull; },
        getLogCount() { return this.logs.length; },
    };
}

function baseReadOnly(overrides = {}) {
    return Object.assign({
        caller: 'caller_addr',
        contractAddress: 'contract_addr',
        contractIndex: 7,
        txHash: 'abc123',
        params: ['p0', 'p1'],
        blockContext: { height: 100, timestamp: 1234567890, hash: 'blockhash' },
        balances: { addrA: { TOK: '500' } },
        tokenInfo: { TOK: { supply: '1000' } },
        oracleData: {
            getPrice: (pair) => (pair === 'BTC/USD' ? '60000' : null),
            getPriceAtRound: (pair, round) => `${pair}@${round}`,
            getSnapshotAge: () => 3,
        },
        crossChainData: {
            getAttestation: (chain, idx) => `att:${chain}:${idx}`,
            isSettled: (chain, idx) => true,
        },
        attestationData: { getResponse: (id) => ({ id, result: 'ok' }) },
        contractStakeData: {
            getStake: (pubkey, token) => '42',
            getTotalStaked: (token) => '100',
            getStakers: (token) => [{ pubkey: 'p', amount: '42' }],
        },
        providerDeadlines: { llm: 20 },
    }, overrides);
}

function build(overrides = {}, execContext = { reverted: false }) {
    const gas = mkGas();
    const state = mkState();
    const collector = mkCollector();
    const gw = buildGateway(gas, state, collector, baseReadOnly(overrides), SCHEDULE, execContext);
    return { gw, gas, state, collector, execContext };
}

module.exports = { SCHEDULE, mkGas, mkState, mkCollector, baseReadOnly, build, buildGateway };
