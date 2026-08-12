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
// Unit tests for src/gateway.js (the host-function surface every contract
// interacts with (read-only context, ledger queries, state, oracle, cross-chain,
// external attestation, contract-targeted staking, control flow, logging).
// Exercised directly here (no isolate) so each branch + gas charge is covered.

const assert = require('assert');
const crypto = require('crypto');
const { buildGateway } = require('../../src/gateway.js');
const { ContractRevertError } = require('../../src/errors.js');

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

describe('Gateway (host-function surface)', function () {

    describe('read-only context (0 gas)', function () {
        it('exposes block context, caller, and contract address', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.getBlockHeight(), 100);
            assert.strictEqual(gw.getBlockTimestamp(), 1234567890);
            assert.strictEqual(gw.getBlockHash(), 'blockhash');
            assert.strictEqual(gw.getSourceAddress(), 'caller_addr');
            assert.strictEqual(gw.getContractAddress(), 'contract_addr');
            assert.strictEqual(gas.charges.length, 0, 'context reads are gas-free');
        });

        it('returns a defensive copy of params', function () {
            const { gw } = build();
            const a = gw.getInputParams();
            assert.deepStrictEqual(a, ['p0', 'p1']);
            a.push('mutated');
            assert.deepStrictEqual(gw.getInputParams(), ['p0', 'p1'], 'caller cannot mutate internal params');
        });

        it('getInputParam returns the value or null for out-of-range', function () {
            const { gw } = build();
            assert.strictEqual(gw.getInputParam(0), 'p0');
            assert.strictEqual(gw.getInputParam(1), 'p1');
            assert.strictEqual(gw.getInputParam(2), null);
            assert.strictEqual(gw.getInputParamCount(), 2);
        });
    });

    describe('ledger queries (VM_STATE_READ)', function () {
        it('getBalance returns the balance and charges a read', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.getBalance('addrA', 'TOK'), '500');
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_READ));
        });
        it('getBalance returns null for unknown address/tick', function () {
            const { gw } = build();
            assert.strictEqual(gw.getBalance('nope', 'TOK'), null);
            assert.strictEqual(gw.getBalance('addrA', 'NOPE'), null);
        });
        it('getBalance returns null when no balances are loaded', function () {
            const { gw } = build({ balances: null });
            assert.strictEqual(gw.getBalance('addrA', 'TOK'), null);
        });
        it('getTokenInfo returns info, null for unknown, null when none loaded', function () {
            assert.deepStrictEqual(build().gw.getTokenInfo('TOK'), { supply: '1000' });
            assert.strictEqual(build().gw.getTokenInfo('NOPE'), null);
            assert.strictEqual(build({ tokenInfo: null }).gw.getTokenInfo('TOK'), null);
        });
    });

    describe('state (metered, delegates to stateManager)', function () {
        it('get/has/set/delete delegate and charge the right gas', function () {
            const { gw, gas, state } = build();
            gw.state.set('k', 'v');
            assert.strictEqual(state.store.get('k'), 'v');
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_WRITE));
            assert.strictEqual(gw.state.get('k'), 'v');
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_READ));
            assert.strictEqual(gw.state.has('k'), true);
            assert.strictEqual(gw.state.delete('k'), true);
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_DELETE));
            assert.strictEqual(gw.state.has('k'), false);
        });
    });

    describe('oracle (metered)', function () {
        it('getPrice / getPriceAtRound delegate and charge a read', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.oracle.getPrice('BTC/USD'), '60000');
            assert.strictEqual(gw.oracle.getPriceAtRound('BTC/USD', 5), 'BTC/USD@5');
            assert.ok(gas.charges.includes(SCHEDULE.VM_ORACLE_READ));
        });
        it('returns null / MAX_SAFE_INTEGER when no oracle data', function () {
            const { gw } = build({ oracleData: null });
            assert.strictEqual(gw.oracle.getPrice('BTC/USD'), null);
            assert.strictEqual(gw.oracle.getPriceAtRound('BTC/USD', 1), null);
            assert.strictEqual(gw.oracle.getSnapshotAge(), Number.MAX_SAFE_INTEGER);
        });
        it('getSnapshotAge delegates when data present (gas-free)', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.oracle.getSnapshotAge(), 3);
            assert.strictEqual(gas.charges.length, 0);
        });
    });

    describe('crossChain (metered)', function () {
        it('getAttestation / isSettled delegate and charge a read', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.crossChain.getAttestation('LTC', 9), 'att:LTC:9');
            assert.strictEqual(gw.crossChain.isSettled('LTC', 9), true);
            assert.ok(gas.charges.includes(SCHEDULE.VM_CROSSCHAIN_READ));
        });
        it('falls back to null / false when no cross-chain data', function () {
            const { gw } = build({ crossChainData: null });
            assert.strictEqual(gw.crossChain.getAttestation('LTC', 9), null);
            assert.strictEqual(gw.crossChain.isSettled('LTC', 9), false);
        });
    });

    describe('attestation.request', function () {
        it('emits ATTEST and returns a deterministic request_id', function () {
            const { gw, collector, gas } = build();
            const id = gw.attestation.request('llm', 'prompt', 'onResult', ['x'], { redundancy: 3, deadlineBlocks: 15 });
            const expected = crypto.createHash('sha256').update('abc123:::7:0').digest('hex');
            assert.strictEqual(id, expected);
            assert.strictEqual(collector.actions.length, 1);
            assert.strictEqual(collector.actions[0].action, 'ATTEST');
            assert.strictEqual(collector.actions[0].params.requestId, expected);
            assert.strictEqual(collector.actions[0].params.callbackParams, '["x"]');
            assert.strictEqual(collector.actions[0].params.redundancy, 3);
            assert.ok(gas.charges.includes(SCHEDULE.VM_ATTEST_REQUEST));
            assert.ok(gas.charges.includes(SCHEDULE.VM_EMISSION));
        });

        it('defaults redundancy=1 and deadlineBlocks=10 when options omitted', function () {
            const { gw, collector } = build();
            gw.attestation.request('llm', 'p', 'cb', []);
            assert.strictEqual(collector.actions[0].params.redundancy, 1);
            assert.strictEqual(collector.actions[0].params.deadlineBlocks, 10);
        });

        it('treats a collector without an actions array as emission index 0', function () {
            // exercises the `emissionCollector.actions ? … : 0` false branch
            const gas = mkGas();
            const captured = [];
            const collector = { add: (a, p) => captured.push({ a, p }) }; // no .actions
            const gw = buildGateway(gas, mkState(), collector, baseReadOnly(), SCHEDULE, { reverted: false });
            const id = gw.attestation.request('llm', 'p', 'cb', []);
            assert.strictEqual(id, crypto.createHash('sha256').update('abc123:::7:0').digest('hex'));
            assert.strictEqual(captured.length, 1);
        });

        it('derives request_id from the live emission index', function () {
            const { gw, collector } = build();
            gw.attestation.request('llm', 'p', 'cb', []);            // emissionIndex 0
            const id2 = gw.attestation.request('llm', 'p', 'cb', []); // emissionIndex 1
            assert.strictEqual(id2, crypto.createHash('sha256').update('abc123:::7:1').digest('hex'));
            assert.strictEqual(collector.actions.length, 2);
        });

        it('handles empty txHash / null contractIndex in the preimage', function () {
            const { gw } = build({ txHash: undefined, contractIndex: null });
            const id = gw.attestation.request('llm', 'p', 'cb', []);
            assert.strictEqual(id, crypto.createHash('sha256').update(':' + ':' + ':' + ':' + '0').digest('hex'));
        });

        it('includes the executing call-path in the preimage (nested-run disambiguation)', function () {
            // Cross-contract calls can run the SAME contract twice in the SAME tx;
            // the execution's deterministic call-path is what keeps their request_ids
            // distinct (and, unlike the old action_index, it does not shift with the
            // indexer's synthetic-action injection timing). MUST byte-match the indexer
            // EMITTER_PATH (xchain-indexer attest.js).
            const { gw } = build({ callPath: '2>0' });
            const id = gw.attestation.request('llm', 'p', 'cb', []);
            assert.strictEqual(id, crypto.createHash('sha256').update('abc123::2>0:7:0').digest('hex'));
        });

        const bad = [
            ['providerId not a string', () => build().gw.attestation.request(1, 'p', 'cb', []), /providerId/],
            ['providerId empty', () => build().gw.attestation.request('', 'p', 'cb', []), /providerId/],
            ['providerId too long', () => build().gw.attestation.request('x'.repeat(33), 'p', 'cb', []), /providerId/],
            ['payload not a string', () => build().gw.attestation.request('llm', 5, 'cb', []), /requestPayload must be a string/],
            ['payload too big', () => build().gw.attestation.request('llm', 'x'.repeat(8193), 'cb', []), /exceeds 8192/],
            ['callbackMethod not a string', () => build().gw.attestation.request('llm', 'p', 9, []), /callbackMethod/],
            ['callbackMethod empty', () => build().gw.attestation.request('llm', 'p', '', []), /callbackMethod/],
            ['callbackMethod too long', () => build().gw.attestation.request('llm', 'p', 'x'.repeat(65), []), /callbackMethod/],
            ['callbackParams not an array', () => build().gw.attestation.request('llm', 'p', 'cb', 'no'), /callbackParams must be an array/],
            ['callbackParams too big', () => build().gw.attestation.request('llm', 'p', 'cb', ['x'.repeat(1025)]), /JSON exceeds 1024/],
            ['redundancy invalid', () => build().gw.attestation.request('llm', 'p', 'cb', [], { redundancy: 2 }), /redundancy must be 1, 3, or 5/],
            ['deadlineBlocks too small', () => build().gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 0 }), /deadlineBlocks/],
            ['deadlineBlocks too large', () => build().gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 101 }), /deadlineBlocks/],
            ['deadlineBlocks non-integer', () => build().gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 2.5 }), /deadlineBlocks/],
        ];
        bad.forEach(([name, fn, re]) => it('rejects: ' + name, () => assert.throws(fn, re)));

        it('rejects callbackParams that are not JSON-serializable', function () {
            const circular = {}; circular.self = circular;
            assert.throws(() => build().gw.attestation.request('llm', 'p', 'cb', [circular]), /JSON-serializable/);
        });

        it('enforces the per-provider deadline window when known', function () {
            assert.throws(
                () => build({ providerDeadlines: { llm: 20 } }).gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 25 }),
                /exceeds the "llm" provider window of 20/);
            // within the window is fine
            assert.doesNotThrow(
                () => build({ providerDeadlines: { llm: 20 } }).gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 20 }));
        });

        it('leaves an unknown provider to the host (no window check)', function () {
            assert.doesNotThrow(
                () => build({ providerDeadlines: { other: 5 } }).gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 50 }));
        });

        it('skips the window check when providerDeadlines is absent', function () {
            assert.doesNotThrow(
                () => build({ providerDeadlines: null }).gw.attestation.request('llm', 'p', 'cb', [], { deadlineBlocks: 50 }));
        });
    });

    describe('attestation.getResponse', function () {
        it('returns the stored response and charges a read', function () {
            const { gw, gas } = build();
            assert.deepStrictEqual(gw.attestation.getResponse('rid'), { id: 'rid', result: 'ok' });
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_READ));
        });
        it('returns null for non-string id or missing data', function () {
            assert.strictEqual(build().gw.attestation.getResponse(5), null);
            assert.strictEqual(build({ attestationData: null }).gw.attestation.getResponse('rid'), null);
        });
    });

    describe('contract staking (read)', function () {
        it('getStake / getTotalStaked / getStakers delegate with a read charge', function () {
            const { gw, gas } = build();
            assert.strictEqual(gw.contract.getStake('pub', 'TOK'), '42');
            assert.strictEqual(gw.contract.getTotalStaked('TOK'), '100');
            assert.deepStrictEqual(gw.contract.getStakers('TOK'), [{ pubkey: 'p', amount: '42' }]);
            assert.ok(gas.charges.includes(SCHEDULE.VM_STATE_READ));
        });
        it('returns 0/0/[] when no stake data is loaded', function () {
            const { gw } = build({ contractStakeData: null });
            assert.strictEqual(gw.contract.getStake('p', 'T'), '0');
            assert.strictEqual(gw.contract.getTotalStaked('T'), '0');
            assert.deepStrictEqual(gw.contract.getStakers('T'), []);
        });
        it('returns 0/0/[] for wrong argument types', function () {
            const { gw } = build();
            assert.strictEqual(gw.contract.getStake(1, 'T'), '0');
            assert.strictEqual(gw.contract.getStake('p', 2), '0');
            assert.strictEqual(gw.contract.getTotalStaked(2), '0');
            assert.deepStrictEqual(gw.contract.getStakers(2), []);
        });
    });

    describe('contract.slash', function () {
        const PUB = 'a'.repeat(64);
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

        // . The 8-dp ceiling contradicted the stake side of the seam (STAKE v3
        // admits a token's own DECIMALS, up to MAX_TOKEN_DECIMALS 18, and
        // slashContractStake deducts at that precision), so a graduated slash of a
        // high-precision token could never be emitted. Widening it ACCEPTS a call that
        // used to throw, which is consensus-visible, so the host gates it; both sides
        // are pinned here.
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

        // . The '|' guard is consensus-visible (a call that used to emit now
        // throws), so the host gates it; both sides of the gate are pinned here.
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

    describe('logging', function () {
        it('log stringifies and joins args; counters reflect collector', function () {
            const { gw, collector } = build();
            gw.log('a', 1, { x: 2 });
            assert.strictEqual(collector.logs.length, 1);
            assert.strictEqual(collector.logs[0], 'a 1 [object Object]');
            assert.strictEqual(gw.getLogCount(), 1);
            assert.strictEqual(gw.isLogFull(), false);
            collector.logFull = true;
            assert.strictEqual(gw.isLogFull(), true);
        });
    });

    describe('composed APIs are wired in', function () {
        it('exposes emit and math sub-APIs', function () {
            const { gw } = build();
            assert.strictEqual(typeof gw.emit, 'object');
            assert.strictEqual(typeof gw.emit.send, 'function');
            assert.strictEqual(typeof gw.math, 'object');
        });
    });
});
