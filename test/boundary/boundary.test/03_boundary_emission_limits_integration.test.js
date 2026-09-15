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

(XChainVM ? describe : describe.skip)('Boundary: Emission Limits (integration)', function() {

    it('E-5: emit then revert discards emissions (atomicity)', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'addr_' + i, tick: 'T', quantity: '1' });
            }
            xchain.revert('rollback');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('E-6: gas exhaustion during emission burst discards', async function() {
        // Each emit costs 500 gas. 5 emits = 2500 gas + computation overhead
        const vm = createVM({ gasCeiling: 1500, maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: '1' });
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert.strictEqual(result.emittedActions.length, 0);
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Emission Limits (integration)', function() {

    it('E-7: all 16 action types at cap', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            xchain.emit.destroy({ tick: 'T', quantity: '1' });
            xchain.emit.issue({ tick: 'NEW' });
            xchain.emit.mint({ tick: 'T', quantity: '1' });
            xchain.emit.order({ giveAmount: '1', getAmount: '1' });
            xchain.emit.dispenser({});
            xchain.emit.dividend({ tick: 'T', dividendTick: 'D', quantity: '1' });
            xchain.emit.airdrop({ tick: 'T', quantity: '1', listActionIndex: 0 });
            xchain.emit.callback({ tick: 'T' });
            xchain.emit.file({});
            xchain.emit.list({});
            xchain.emit.coinpay({ orderMatchActionIndex: 0 });
            xchain.emit.sweep({ destination: 'a' });
            xchain.emit.link({ coin1: 'BTC', coin1ActionIndex: 0, coin2: 'LTC', coin2ActionIndex: 0 });
            xchain.emit.broadcast({});
            xchain.emit.message({ destination: 'a' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 16);
        const types = result.emittedActions.map(a => a.action);
        assert(types.includes('SEND'));
        assert(types.includes('DESTROY'));
        assert(types.includes('ISSUE'));
        assert(types.includes('MINT'));
        assert(types.includes('ORDER'));
        assert(types.includes('DISPENSER'));
        assert(types.includes('DIVIDEND'));
        assert(types.includes('AIRDROP'));
        assert(types.includes('CALLBACK'));
        assert(types.includes('FILE'));
        assert(types.includes('LIST'));
        assert(types.includes('COINPAY'));
        assert(types.includes('SWEEP'));
        assert(types.includes('LINK'));
        assert(types.includes('BROADCAST'));
        assert(types.includes('MESSAGE'));
    });
});
