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
const fs = require('fs');
const path = require('path');
const { CONTRACT_HOST_FIXTURES } = require('./contract-host-fixtures.js');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping determinism tests, isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500,
    // Cross-chain call buckets. MUST match the production per-chain configs
    // (xchain-indexer/src/configs/{BTC,LTC,DOGE}.js). gateway-emit.js carries
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

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    const baseOpts = {
        state: { counter: '5', owner: 'addr1' },
        method: 'default',
        params: ['arg1', 'arg2'],
        caller: 'addr1',
        contractAddress: 'C:BTC:100',
        blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash123' }
    };

    it('should produce identical results for state_counter', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/state_counter.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'increment', state: { counter: '5' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical results for simple_send', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/simple_send.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'send', params: ['dest_addr', '100'],
                       state: { owner: 'addr1', token: 'TEST' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical results for amm_swap', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/amm_swap.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'swap', params: ['100', 'TOKENA'],
                       state: { tokenA: 'TOKENA', tokenB: 'TOKENB', reserveA: '10000', reserveB: '5000' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical gas usage', async function() {
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 10; i++) {
                xchain.state.set('key_' + i, String(i));
            }
            return 'done';
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(r1.gasUsed, r2.gasUsed);
    });

    it('should produce identical failure results', async function() {
        const code = `module.exports = function(xchain) {
            xchain.state.set('before', 'revert');
            xchain.revert('test failure');
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, false);
    });

    it('should produce identical results for math operations', async function() {
        const code = `module.exports = function(xchain) {
            var a = xchain.math.divide('1', '3');
            var b = xchain.math.multiply(a, '3');
            var c = xchain.math.subtract(b, '1');
            return { a: a, b: b, c: c };
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for emit operations', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'addr1', tick: 'T', quantity: '100' });
            xchain.emit.send({ destination: 'addr2', tick: 'T', quantity: '200' });
            return 'done';
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.emittedActions.length, 2);
    });

    // Contract-targeted staking, external attestation, and cross-contract /
    // cross-chain call host methods. These run on every chain in the indexer
    // EXECUTE path, so a gas-charging, response-serialisation, or
    // __gas-injection regression here must fail CI rather than silently
    // diverge an on-chain block hash. Fixtures (code + injected accessors)
    // are shared with determinism-baseline.test.js. Fixtures flagged
    // expectSuccess: false pin a deterministic failure (e.g. the emit.execute
    // depth-gate throw); the run-twice equality assertion applies either way.
    CONTRACT_HOST_FIXTURES.forEach(function(f) {
        it(`should produce identical results for ${f.name}`, async function() {
            const opts = { ...baseOpts, code: f.code, ...(f.extra || {}) };
            const [r1, r2] = await runTwice(vm, opts);
            assert.strictEqual(hashResult(r1), hashResult(r2));
            assert.strictEqual(r1.success, f.expectSuccess !== false, r1.error);
        });
    });

    it('should produce identical results across 5 runs', async function() {
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 5; i++) {
                xchain.state.set('k' + i, xchain.math.multiply(String(i), '10'));
            }
            return 'done';
        };`;
        const opts = { ...baseOpts, code, state: {} };
        const hashes = [];
        for (let i = 0; i < 5; i++) {
            const result = await vm.execute(opts);
            hashes.push(hashResult(result));
        }
        const allEqual = hashes.every(h => h === hashes[0]);
        assert(allEqual, 'all 5 runs should produce identical results');
    });

    // Fix 4016: readManifest (Phase E deploy path) determinism.
    // vm.readManifest(code) is called at every DEPLOY, hashes into accept/reject
    // status, and persists to contract_permissions. A regression in the
    // __readManifest branch, JSON serialization, or type-tagging would shift
    // the deploy outcome. These run-twice checks catch same-process regressions;
    // see determinism-baseline.test.js for the committed cross-arch digest.
    it('should produce identical results for readManifest: well-formed manifest', async function() {
        const code = `
module.exports = {
    permissions: ['SEND', 'MINT'],
    maxTakeBps: 250
};`;
        const [r1, r2] = await runTwice(vm, { ...baseOpts, code, method: '__manifest__', readManifest: true, state: {} });
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        const m = JSON.parse(r1.returnValue);
        assert.deepStrictEqual(m.permissions, ['SEND', 'MINT']);
        assert.strictEqual(m.permissionsType, 'array');
        assert.strictEqual(m.maxTakeBps, 250);
        assert.strictEqual(m.maxTakeBpsType, 'number');
    });

    it('should produce identical results for readManifest: manifest with wrong types', async function() {
        // permissions as a string (not an array) and maxTakeBps absent: the VM
        // must report the type tags faithfully so the indexer can fail-closed.
        const code = `
module.exports = {
    permissions: 'SEND',
    maxTakeBps: '100'
};`;
        const [r1, r2] = await runTwice(vm, { ...baseOpts, code, method: '__manifest__', readManifest: true, state: {} });
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        const m = JSON.parse(r1.returnValue);
        assert.strictEqual(m.permissions, null);
        assert.strictEqual(m.permissionsType, 'string');
        assert.strictEqual(m.maxTakeBps, null);
        assert.strictEqual(m.maxTakeBpsType, 'string');
    });

    it('should produce identical results for readManifest: no manifest exported', async function() {
        // A constructor-less contract (plain function export) with no permissions
        // property. The VM must return null for both fields.
        const code = `module.exports = function(xchain) { return 'hello'; };`;
        const [r1, r2] = await runTwice(vm, { ...baseOpts, code, method: '__manifest__', readManifest: true, state: {} });
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        const m = JSON.parse(r1.returnValue);
        assert.strictEqual(m.permissions, null);
        assert.strictEqual(m.permissionsType, 'undefined');
        assert.strictEqual(m.maxTakeBps, null);
        assert.strictEqual(m.maxTakeBpsType, 'undefined');
    });

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

    // Fix 3910: controller-guard execution path (isGuard=true) determinism.
    // runControllerGuard writes a parent contract_executions row; the guard's
    // gasUsed, emission set, and basePosition offset are live consensus inputs
    // that must be identical across runs. isGuard also disables attestation
    // and cross-chain calls; those rejections must be deterministic too.

    it('should produce identical results for guard: allow with emit.send', async function() {
        // A guard that returns a value (allow) and emits a send (royalty split
        // pattern). Both gasUsed and the emitted action must be identical.
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'royalty_addr', tick: 'TOKENX', quantity: '10' });
            return 'allow';
        };`;
        const opts = { ...baseOpts, code, state: {}, isGuard: true };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.emittedActions.length, 1);
    });

    it('should produce identical results for guard: deny via revert', async function() {
        const code = `module.exports = function(xchain) {
            xchain.revert('transfer blocked by policy');
        };`;
        const opts = { ...baseOpts, code, state: {}, isGuard: true };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, false);
        assert.ok(r1.error.startsWith('revert:'));
    });

    it('should produce identical results for guard: attestation.request blocked deterministically', async function() {
        // A guard attempting attestation.request must receive a deterministic
        // throw (not a silent skip), so the error is pinned.
        const code = `module.exports = function(xchain) {
            return xchain.attestation.request('provider', 'payload', 'cb', [], {});
        };`;
        const opts = { ...baseOpts, code, state: {}, isGuard: true, txHash: 'abc', contractIndex: 1 };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, false);
        assert.ok(r1.error.includes('not available to a controller guard'),
            'expected guard attestation rejection, got: ' + r1.error);
    });

    it('should produce identical results for guard: state read + conditional emit', async function() {
        // Multi-guard basePosition scenario: a guard that reads state and
        // conditionally emits. Both branches must be internally deterministic.
        const code = `module.exports = function(xchain) {
            var owner = xchain.state.get('owner');
            if (owner === 'addr1') {
                xchain.emit.send({ destination: 'treasury', tick: 'TOKENX', quantity: '5' });
                return 'allow';
            }
            xchain.revert('not the owner');
        };`;
        const opts = { ...baseOpts, code, state: { owner: 'addr1' }, isGuard: true };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    // Fix 4095: binary-alloc metering (F3-binary) determinism fixtures.
    // These run at a post-flag-day blockContext.timestamp so the byte-length
    // charge is active. A regression in __meterBinaryCtor wrapping (including
    // newly added Float16Array) or in the BYTES_PER_ELEMENT accounting would
    // shift gasUsed; the run-twice check catches same-process regressions.
    // See binary-alloc-gate.regression.test.js for the gate-boundary check and
    // determinism-baseline.test.js for the committed cross-arch digest.

    const POST_GATE_CTX = {
        height: 999,
        timestamp: (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800,
        hash: 'post_gate_hash'
    };

    it('should produce identical gasUsed for Uint8Array allocation (post-flag-day)', async function() {
        const code = `module.exports = function() { var a = new Uint8Array(200); return a.length; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        // Uint8Array(200) charges 200 bytes (BYTES_PER_ELEMENT = 1).
        assert.ok(r1.gasUsed >= 200, 'expected >= 200 gas for 200-byte allocation, got ' + r1.gasUsed);
    });

    it('should produce identical gasUsed for Float64Array allocation (post-flag-day)', async function() {
        // Float64Array(100) = 100 * 8 = 800 bytes; charge must be 800.
        const code = `module.exports = function() { var a = new Float64Array(100); return a.length; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.ok(r1.gasUsed >= 800, 'expected >= 800 gas for Float64Array(100), got ' + r1.gasUsed);
    });

    it('should produce identical gasUsed for ArrayBuffer allocation (post-flag-day)', async function() {
        const code = `module.exports = function() { var b = new ArrayBuffer(512); return b.byteLength; };`;
        const opts = { ...baseOpts, code, state: {}, blockContext: POST_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.ok(r1.gasUsed >= 512, 'expected >= 512 gas for ArrayBuffer(512), got ' + r1.gasUsed);
    });

    it('should produce identical gasUsed for TypedArray view (no new backing store, no charge)', async function() {
        // A TypedArray constructed over an existing ArrayBuffer must NOT charge
        // for the backing bytes (no new allocation). This is the no-charge branch
        // in __meterBinaryCtor: first arg is an ArrayBuffer, not a number.
        const code = `module.exports = function() {
            var buf = new ArrayBuffer(64);
            var view = new Uint8Array(buf);
            return view.length;
        };`;
        // Run pre-flag-day so the ArrayBuffer allocation is also unmetered;
        // we only want to confirm the view does not add charge on top.
        const PRE_GATE_CTX = { height: 1, timestamp: 0, hash: 'pre_gate' };
        const opts = { ...baseOpts, code, state: {}, blockContext: PRE_GATE_CTX };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.returnValue, '64');
    });

    it('should produce no binary-alloc charge below the flag-day timestamp', async function() {
        const code = `module.exports = function() { var a = new Uint8Array(50000); return a.length; };`;
        const PRE_GATE_CTX = { height: 1, timestamp: 0, hash: 'pre_gate' };
        const POST_GATE = POST_GATE_CTX;
        const optsPre  = { ...baseOpts, code, state: {}, blockContext: PRE_GATE_CTX };
        const optsPost = { ...baseOpts, code, state: {}, blockContext: POST_GATE };
        const pre  = await vm.execute(optsPre);
        const post = await vm.execute(optsPost);
        assert.strictEqual(pre.success, true);
        assert.strictEqual(post.success, true);
        // Post-gate must carry the 50000-byte charge; pre-gate must not.
        assert.ok(post.gasUsed >= 50000, 'post-gate gasUsed must include byte charge, got ' + post.gasUsed);
        assert.ok(pre.gasUsed < 50000,  'pre-gate gasUsed must NOT include byte charge, got ' + pre.gasUsed);
        assert.ok(post.gasUsed > pre.gasUsed, 'gasUsed must differ across the gate');
    });
});
