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
    // (xchain-indexer/src/coins/{BTC,LTC,DOGE}.js). gateway-emit.js carries
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
});

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

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
});
