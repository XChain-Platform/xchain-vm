// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping limits tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling || 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs || 5000,
            maxMemory: overrides?.maxMemory || 8,
            maxEmissions: overrides?.maxEmissions || 50,
            maxStateKeys: overrides?.maxStateKeys || 10000,
            maxStateValueSize: overrides?.maxStateValueSize || 65536,
            maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code: code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: 'test_addr',
        contractAddress: 'C:BTC:1',
        blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
    });
}

(XChainVM ? describe : describe.skip)('Limits', function() {

    it('should hit gas limit on infinite loop', async function() {
        this.timeout(10000);
        const vm = createVM({ gasCeiling: 1000 });
        const code = fs.readFileSync(path.join(__dirname, '../contracts/infinite_loop.js'), 'utf8');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), 'should be out of gas: ' + result.error);
        // gasUsed clamps to the ceiling on exhaustion (a single charge can overshoot,
        // but the caller is never billed beyond their committed ceiling).
        assert.strictEqual(result.gasUsed, 1000, 'gasUsed should clamp to the ceiling: ' + result.gasUsed);
    });

    it('should hit memory limit on memory bomb', async function() {
        this.timeout(10000);
        const vm = createVM({ maxMemory: 8 });
        const code = fs.readFileSync(path.join(__dirname, '../contracts/memory_bomb.js'), 'utf8');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        // Could be out_of_memory or out_of_gas (memory pressure triggers gas)
        assert(result.error.includes('out_of_memory') || result.error.includes('out_of_gas') ||
               result.error.includes('timeout') || result.error.includes('error:'),
               'should fail: ' + result.error);
    });

    it('should hit emission limit at 51', async function() {
        const vm = createVM();
        const code = fs.readFileSync(path.join(__dirname, '../contracts/emit_flood.js'), 'utf8');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('emission limit'), 'should hit emission limit: ' + result.error);
    });

    it('should hit state key limit', async function() {
        const vm = createVM({ maxStateKeys: 100 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 101; i++) {
                xchain.state.set('key_' + i, 'value');
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('max state keys'), 'should hit key limit: ' + result.error);
    });

    it('should hit state value size limit', async function() {
        const vm = createVM({ maxStateValueSize: 100 });
        const code = `module.exports = function(xchain) {
            var big = '';
            for (var i = 0; i < 200; i++) big += 'x';
            xchain.state.set('key', big);
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('max size'), 'should hit value size limit: ' + result.error);
    });

    it('should charge gas on failure', async function() {
        const vm = createVM();
        const code = `module.exports = function(xchain) {
            xchain.state.set('key', 'value');
            xchain.revert('fail');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.gasUsed > 0, 'gas should be charged on failure');
    });

    it('should return empty state changes on failure', async function() {
        const vm = createVM();
        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
            xchain.revert('rollback');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stateChanges.length, 0);
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('should reject code exceeding maxCodeSize', async function() {
        const vm = createVM();
        const oversized = '// ' + 'x'.repeat(65540);
        const result = await executeCode(vm, oversized);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('code size exceeds limit'), 'error: ' + result.error);
    });

    it('should accept code at exactly maxCodeSize', async function() {
        const vm = createVM();
        const header = 'module.exports = function(xchain) { /* ';
        const footer = ' */ };';
        const padding = 65536 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert.strictEqual(Buffer.byteLength(code, 'utf8'), 65536);
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });
});
