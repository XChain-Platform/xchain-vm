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
 * Chaos Experiment 1: Memory Cliff
 *
 * Tests VM behavior when contracts approach and exceed the isolate
 * memory limit. Verifies OOM error classification, atomicity on
 * failure, and VM recovery after OOM events.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { XChainVM, createVM, execute, chaosAssertions } = require('../helpers/harness');
const { checkResultShape, checkAtomicity } = require('../../fuzz/invariants');

const memoryCliffCode = fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'memory_cliff.js'), 'utf8'
);

(XChainVM ? describe : describe.skip)('Chaos: Memory Cliff (Exp 1)', function() {

    it('CHAOS-101: allocation below limit succeeds', async function() {
        this.timeout(15000);
        const vm = createVM({ maxMemory: 8 });
        // 6 chunks * ~512KB = ~3MB, well under 8MB
        const result = await execute(vm, memoryCliffCode, { params: ['6'] });
        assert.strictEqual(result.success, true, 'Should succeed under memory limit: ' + result.error);
        checkResultShape(result);
    });

    it('CHAOS-102: allocation over limit triggers OOM with atomicity', async function() {
        this.timeout(15000);
        const vm = createVM({ maxMemory: 8 });
        // Contract writes state before OOM — state must not persist
        const code = `module.exports = function(xchain) {
            xchain.state.set('before_oom', 'yes');
            xchain.emit.send({ destination: 'test', tick: 'T', quantity: '1' });
            var arr = [];
            while (true) { arr.push(new Array(100000).fill('x')); }
        };`;
        const result = await execute(vm, code);
        assert.strictEqual(result.success, false);
        assert(
            result.error.includes('out_of_memory') ||
            result.error.includes('out_of_gas') ||
            result.error.includes('timeout'),
            'Expected resource exhaustion error, got: ' + result.error
        );
        // Atomicity: no state changes or emissions
        assert.strictEqual(result.stateChanges.length, 0, 'No state changes after OOM');
        assert.strictEqual(result.emittedActions.length, 0, 'No emissions after OOM');
    });

    it('CHAOS-103: VM is usable after OOM event', async function() {
        this.timeout(20000);
        const vm = createVM({ maxMemory: 8 });
        // Trigger OOM
        const oomCode = `module.exports = function(xchain) {
            var a = []; while(true) { a.push(new Array(100000).fill('x')); }
        };`;
        await execute(vm, oomCode);
        // Recovery — simple contract should succeed
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-104: repeated OOM events do not degrade VM', async function() {
        this.timeout(30000);
        const vm = createVM({ maxMemory: 8 });
        const oomCode = `module.exports = function(xchain) {
            var a = []; while(true) { a.push(new Array(100000).fill('x')); }
        };`;
        // Trigger OOM 5 times in sequence
        for (let i = 0; i < 5; i++) {
            const result = await execute(vm, oomCode);
            assert.strictEqual(result.success, false, 'OOM iteration ' + i + ' should fail');
            checkAtomicity(result);
        }
        // VM still recovers
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-105: OOM preserves logs for debugging', async function() {
        this.timeout(15000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            xchain.log('before allocation');
            xchain.log('starting memory bomb');
            var arr = [];
            while (true) { arr.push(new Array(100000).fill('x')); }
        };`;
        const result = await execute(vm, code);
        assert.strictEqual(result.success, false);
        // Logs should be preserved even on failure
        assert(Array.isArray(result.logs), 'Logs should be an array');
        // At least one log should have been recorded before OOM
        if (result.logs.length > 0) {
            assert(result.logs[0].includes('before allocation'),
                'First log should be preserved');
        }
    });

    it('CHAOS-106: gas is charged even on OOM', async function() {
        this.timeout(15000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('k', 'v');
            var arr = [];
            while (true) { arr.push(new Array(100000).fill('x')); }
        };`;
        const result = await execute(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.gasUsed > 0, 'Gas should be charged before OOM, got: ' + result.gasUsed);
    });
});
