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
const { CONTRACT_HOST_FIXTURES } = require('../helpers/contract_host_fixtures.js');

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
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

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
});
