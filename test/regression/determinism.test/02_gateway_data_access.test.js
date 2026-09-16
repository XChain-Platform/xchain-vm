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
const crypto = require('crypto');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping determinism tests, isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    // Cross-chain call buckets. MUST match the production per-chain configs
    // (xchain-indexer/src/coins/{BTC,LTC,DOGE}.js). gateway_emit.js carries
    // identical fallback defaults, but the keys are pinned here explicitly so
    // the crossExecute baselines are computed against the production schedule.
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        execution: 'in-process',  // explicit: containment not needed in unit/fuzz harnesses
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function hashResult(result) {
    // Normalize for comparison: sort state changes by key
    const normalized = {
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed,
        returnValue: result.returnValue,
        stateChanges: [...result.stateChanges].sort((a, b) => a.key.localeCompare(b.key)),
        stateDeletes: [...result.stateDeletes].sort(),
        emittedActions: result.emittedActions,
        logs: result.logs
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function runTwice(vm, opts) {
    const result1 = await vm.execute(opts);
    const result2 = await vm.execute(opts);
    return [result1, result2];
}

const baseOpts = {
    state: { counter: '5', owner: 'addr1' },
    method: 'default',
    params: ['arg1', 'arg2'],
    caller: 'addr1',
    contractAddress: 'C:BTC:100',
    blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash123' }
};

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    // Fix 3600: gas-charging gateway methods absent from determinism suites.
    // Each of these methods charges gas and/or serializes data that lands in
    // emittedActions or returnValue; a regression in the gas charge or the
    // ivm-boundary serialization shifts gasUsed/output without CI signal.
    // Deterministic stand-in accessors mirror the production accessor shapes.

    it('should produce identical results for oracle.getPriceAtRound', async function() {
        const oracleData = {
            getPrice: () => '50000.00',
            getPriceAtRound: (pair, round) => (pair === 'BTC/USD' && round === 5) ? '48000.00' : null,
            getSnapshotAge: () => 3
        };
        const code = `module.exports = function(xchain) {
            return {
                current: xchain.oracle.getPrice('BTC/USD'),
                atRound: xchain.oracle.getPriceAtRound('BTC/USD', 5),
                missing: xchain.oracle.getPriceAtRound('BTC/USD', 99)
            };
        };`;
        const opts = { ...baseOpts, code, state: {}, oracleData };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for crossChain.getAttestation', async function() {
        const crossChainData = {
            getAttestation: (chain, idx) => (chain === 'LTC' && idx === 10)
                ? { status: 'ok', payload: '{"val":42}', blockIndex: 100 } : null,
            isSettled: () => false,
            getCallResult: () => null
        };
        const code = `module.exports = function(xchain) {
            return {
                found:   xchain.crossChain.getAttestation('LTC', 10),
                missing: xchain.crossChain.getAttestation('DOGE', 10)
            };
        };`;
        const opts = { ...baseOpts, code, state: {}, crossChainData };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should produce identical results for crossChain.isSettled', async function() {
        const crossChainData = {
            getAttestation: () => null,
            isSettled: (chain, idx) => (chain === 'LTC' && idx === 7),
            getCallResult: () => null
        };
        const code = `module.exports = function(xchain) {
            return {
                yes: xchain.crossChain.isSettled('LTC', 7),
                no:  xchain.crossChain.isSettled('LTC', 8)
            };
        };`;
        const opts = { ...baseOpts, code, state: {}, crossChainData };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for crossChain.getCallResult', async function() {
        const crossChainData = {
            getAttestation: () => null,
            isSettled: () => false,
            getCallResult: (id) => id === 'callid_abc'
                ? { status: 'ok', payload: '{"result":1}' } : null
        };
        const code = `module.exports = function(xchain) {
            return {
                hit:  xchain.crossChain.getCallResult('callid_abc'),
                miss: xchain.crossChain.getCallResult('callid_xyz')
            };
        };`;
        const opts = { ...baseOpts, code, state: {}, crossChainData };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should produce identical results for getBalance (VM_STATE_READ charged)', async function() {
        const code = `module.exports = function(xchain) {
            return {
                bal:     xchain.getBalance('addr1', 'TOKENX'),
                missing: xchain.getBalance('addr2', 'TOKENX')
            };
        };`;
        const opts = {
            ...baseOpts, code, state: {},
            balances: { addr1: { TOKENX: '1000.00000000' } }
        };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for getTokenInfo (VM_STATE_READ charged)', async function() {
        const code = `module.exports = function(xchain) {
            return {
                found:   xchain.getTokenInfo('TOKENX'),
                missing: xchain.getTokenInfo('TOKENY')
            };
        };`;
        const opts = {
            ...baseOpts, code, state: {},
            tokenInfo: { TOKENX: { supply: '1000000', decimals: 8, owner: 'addr1' } }
        };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for state.has (VM_STATE_READ charged)', async function() {
        const code = `module.exports = function(xchain) {
            return {
                present: xchain.state.has('existing_key'),
                absent:  xchain.state.has('no_such_key')
            };
        };`;
        const opts = { ...baseOpts, code, state: { existing_key: 'value' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should produce identical results for state.delete (VM_STATE_DELETE charged)', async function() {
        const code = `module.exports = function(xchain) {
            xchain.state.delete('k1');
            xchain.state.delete('k2');
            return 'done';
        };`;
        const opts = { ...baseOpts, code, state: { k1: 'v1', k2: 'v2' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.stateDeletes.length, 2);
    });
});
