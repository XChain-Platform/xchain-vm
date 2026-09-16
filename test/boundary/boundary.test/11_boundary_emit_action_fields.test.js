/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM: Boundary Test Suite
 *
 * Tests the VM at the exact edges of every configurable limit, hardcoded cap,
 * and validation threshold. Each section targets a specific boundary area
 * from the Boundary Testing Plan.
 *
 * Sections:
 *   1. Gas Ceiling Enforcement (G-1 through G-7)
 *   2. Wall-Clock Timeout (T-1 through T-4)
 *   3. Memory Limits (M-1 through M-4)
 *   4. Code Size (CS-1 through CS-6)
 *   5. State Management (S-1 through S-14)
 *   6. Emission Limits (E-1 through E-7)
 *   7. Log Limits (L-1 through L-7)
 *   8. Return Value Truncation (R-1 through R-5)
 *   9. Math Operations (MA-1 through MA-10)
 *  10. Metering & AST Injection (ME-1 through ME-7)
 *  11. Sandbox Escape Boundaries (SB-1 through SB-8)
 *  12. Gateway Parameter Boundaries (GW-1 through GW-9)
 *  13. Emit Action Field Boundaries (EA-1 through EA-8)
 *  14. Compound Interaction Boundaries
 *  15. Determinism at Boundaries
 */
// @ts-nocheck

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../../src/index.js');
} catch (e) {
    console.log('Skipping VM boundary tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling !== undefined ? overrides.gasCeiling : 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs !== undefined ? overrides.maxCpuTimeMs : 5000,
            maxMemory: overrides?.maxMemory !== undefined ? overrides.maxMemory : 8,
            maxEmissions: overrides?.maxEmissions !== undefined ? overrides.maxEmissions : 50,
            maxStateKeys: overrides?.maxStateKeys !== undefined ? overrides.maxStateKeys : 10000,
            maxStateValueSize: overrides?.maxStateValueSize !== undefined ? overrides.maxStateValueSize : 65536,
            maxCodeSize: overrides?.maxCodeSize !== undefined ? overrides.maxCodeSize : 65536,
            maxStateKeySize: overrides?.maxStateKeySize !== undefined ? overrides.maxStateKeySize : 1024,
            maxBlockCacheSize: overrides?.maxBlockCacheSize !== undefined ? overrides.maxBlockCacheSize : 1000
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code:            code,
        state:           opts?.state || {},
        method:          opts?.method || 'default',
        params:          opts?.params || [],
        caller:          opts?.caller !== undefined ? opts.caller : 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext:    opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances:        opts?.balances || {},
        tokenInfo:       opts?.tokenInfo || {},
        oracleData:      opts?.oracleData || null,
        crossChainData:  opts?.crossChainData || null
    });
}

// Boundary group 13: Emit Action Field Boundaries (EA-1 through EA-8)

(XChainVM ? describe : describe.skip)('Boundary: Emit Action Fields', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('EA-1: SEND with quantity "0" passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: '0' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.quantity, '0');
    });

    it('EA-2: SEND with negative quantity passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: '-1' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.quantity, '-1');
    });

    it('EA-3: SEND with non-string quantity rejected by type validation', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: 12345 });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'should reject non-string quantity: ' + result.error);
    });

    it('EA-4: ISSUE with tick "" passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.issue({ tick: '' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.tick, '');
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Emit Action Fields', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('EA-5: DISPENSER with empty params passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.dispenser({});
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });

    it('EA-6: DISPENSER with null params treated as empty', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.dispenser(null);
        };`;
        const result = await executeCode(vm, code);
        // null spreads to {} (should not crash)
        assert.strictEqual(result.success, true);
    });

    it('EA-7: emit with extra unknown fields passes through', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({
                destination: 'x', tick: 'T', quantity: '1',
                evil: 'payload', extra: 42
            });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.evil, 'payload');
        assert.strictEqual(result.emittedActions[0].params.extra, 42);
    });

    it('EA-8: LINK with MAX_SAFE_INTEGER actionIndex passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.link({
                coin1: 'BTC', coin1ActionIndex: 9007199254740991,
                coin2: 'LTC', coin2ActionIndex: 9007199254740991
            });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.coin1ActionIndex, 9007199254740991);
    });
});
