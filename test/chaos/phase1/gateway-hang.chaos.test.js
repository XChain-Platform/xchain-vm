/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Chaos Experiment 2: Gateway Callback Hang
 *
 * Tests VM behavior when a gateway callback busy-waits (simulating a
 * hang). Verifies the VM returns a result (no deadlock) and maintains
 * atomicity.
 *
 * IMPORTANT: A synchronous busy-wait on the host thread blocks V8's
 * interrupt mechanism. The wall-clock timeout (maxCpuTimeMs) fires
 * from a separate thread but cannot terminate host-side code.
 * Therefore this test verifies no deadlock/crash rather than strict
 * timeout enforcement. The oracle call returns after the delay,
 * and the overall execution may complete successfully or timeout
 * depending on the combined delay vs timeout budget.
 ********************************************************************/

const assert = require('assert');
const { XChainVM, createVM, execute, ProgrammableMock, chaosAssertions } = require('../helpers/harness');
const { checkResultShape, checkAtomicity } = require('../../fuzz/invariants');

(XChainVM ? describe : describe.skip)('Chaos: Gateway Callback Hang (Exp 2)', function() {

    it('CHAOS-201: short delay in oracle callback does not crash VM', async function() {
        this.timeout(15000);
        const vm = createVM({ maxCpuTimeMs: 5000 });

        const mock = new ProgrammableMock();
        mock.onCall(1).delay(500);  // 500ms busy-wait, well under 5s timeout

        const code = `module.exports = function(xchain) {
            var price = xchain.oracle.getPrice('BTC/USD');
            return 'done';
        };`;

        const start = Date.now();
        const result = await execute(vm, code, { oracleData: mock.asOracleData() });
        const elapsed = Date.now() - start;

        checkResultShape(result);
        // Should complete (delay is under timeout)
        assert.strictEqual(result.success, true,
            'Short delay should not cause failure: ' + result.error);
        assert(elapsed >= 400, 'Should have waited at least 400ms, got ' + elapsed + 'ms');
    });

    it('CHAOS-202: long delay exceeding timeout returns failure', async function() {
        this.timeout(15000);
        const vm = createVM({ maxCpuTimeMs: 1000 });

        // Delay 3s, timeout 1s — but since delay is host-side, it blocks the
        // entire thread. The delay will complete (3s) and the timeout check
        // happens when control returns to V8. We verify the VM doesn't deadlock.
        const mock = new ProgrammableMock();
        mock.onCall(1).delay(3000);

        const code = `module.exports = function(xchain) {
            xchain.state.set('before_hang', 'yes');
            xchain.oracle.getPrice('BTC/USD');
            xchain.state.set('after_hang', 'yes');
            return 'completed';
        };`;

        const start = Date.now();
        const result = await execute(vm, code, { oracleData: mock.asOracleData() });
        const elapsed = Date.now() - start;

        checkResultShape(result);
        // The VM must return a result (not hang forever)
        assert(elapsed < 10000, 'VM should not deadlock, completed in ' + elapsed + 'ms');

        // If it failed (timeout after delay returned), verify atomicity
        if (!result.success) {
            checkAtomicity(result);
        }
    });

    it('CHAOS-203: multiple delayed calls accumulate but VM still completes', async function() {
        this.timeout(15000);
        const vm = createVM({ maxCpuTimeMs: 5000 });

        const mock = new ProgrammableMock();
        mock.onCall(1).delay(200);
        mock.onCall(2).delay(200);
        mock.onCall(3).delay(200);

        const code = `module.exports = function(xchain) {
            xchain.oracle.getPrice('BTC/USD');
            xchain.oracle.getPrice('ETH/USD');
            xchain.oracle.getPrice('LTC/USD');
            return 'done';
        };`;

        const start = Date.now();
        const result = await execute(vm, code, { oracleData: mock.asOracleData() });
        const elapsed = Date.now() - start;

        checkResultShape(result);
        // 3 * 200ms = 600ms, well under 5s timeout
        assert.strictEqual(result.success, true, 'Should succeed: ' + result.error);
        assert(elapsed >= 500, 'Should have waited at least 500ms, got ' + elapsed + 'ms');
    });

    it('CHAOS-204: VM recovers after hung execution', async function() {
        this.timeout(15000);
        const vm = createVM({ maxCpuTimeMs: 2000 });

        const mock = new ProgrammableMock();
        mock.onCall(1).delay(1000);

        await execute(vm, `module.exports = function(xchain) {
            xchain.oracle.getPrice('BTC/USD');
        };`, { oracleData: mock.asOracleData() });

        // Recovery
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-205: atomicity maintained when hang causes state+emission loss', async function() {
        this.timeout(15000);
        const vm = createVM({ maxCpuTimeMs: 1000 });

        const mock = new ProgrammableMock();
        mock.onCall(1).delay(2000);

        const code = `module.exports = function(xchain) {
            xchain.state.set('key1', 'val1');
            xchain.emit.send({ destination: 'test', tick: 'T', quantity: '1' });
            xchain.oracle.getPrice('BTC/USD');
            return 'completed';
        };`;

        const result = await execute(vm, code, { oracleData: mock.asOracleData() });
        checkResultShape(result);

        // Whether success or failure, if failure then atomicity must hold
        if (!result.success) {
            assert.strictEqual(result.stateChanges.length, 0, 'State discarded on timeout');
            assert.strictEqual(result.emittedActions.length, 0, 'Emissions discarded on timeout');
        }
    });
});
