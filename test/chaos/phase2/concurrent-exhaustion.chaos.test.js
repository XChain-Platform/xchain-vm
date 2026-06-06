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
 * Chaos Experiment 5: Concurrent Isolate Exhaustion
 *
 * Tests VM behavior under concurrent execution load. Each vm.execute()
 * creates a fresh V8 isolate, so concurrency safety relies on per-call
 * resource allocation. Node.js is single-threaded, so Promise.all
 * interleaving only happens at await points (all after isolate disposal).
 *
 * Verifies: no crashes, result isolation, correct behavior under load,
 * mixed success/failure concurrency.
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');
const { XChainVM, createVM, execute, chaosAssertions } = require('../helpers/harness');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('../../fuzz/invariants');

(XChainVM ? describe : describe.skip)('Chaos: Concurrent Isolate Exhaustion (Exp 5)', function() {

    it('CHAOS-501: 20 concurrent executions all complete without crash', async function() {
        this.timeout(60000);
        const vm = createVM();
        const CONCURRENCY = 20;

        const code = `module.exports = function(xchain) {
            var id = xchain.getInputParam(0);
            xchain.state.set('id', id);
            return id;
        };`;

        const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
            execute(vm, code, { params: [String(i)] })
        );
        const results = await Promise.all(promises);

        for (let i = 0; i < CONCURRENCY; i++) {
            checkResultShape(results[i]);
            if (results[i].success) {
                const returned = JSON.parse(results[i].returnValue);
                assert.strictEqual(returned, String(i),
                    'Execution ' + i + ' returned wrong value: ' + returned);
            }
        }

        checkNoPrototypePollution();
    });

    it('CHAOS-502: concurrent results are isolated (no state bleed)', async function() {
        this.timeout(60000);
        const vm = createVM();
        const CONCURRENCY = 10;

        const code = `module.exports = function(xchain) {
            var id = xchain.getInputParam(0);
            xchain.state.set('owner', id);
            xchain.state.set('counter', xchain.math.add('0', id));
            return { id: id, counter: xchain.state.get('counter') };
        };`;

        const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
            execute(vm, code, { params: [String(i + 1)] })
        );
        const results = await Promise.all(promises);

        for (let i = 0; i < CONCURRENCY; i++) {
            checkResultShape(results[i]);
            if (results[i].success) {
                // Each execution should have exactly 2 state changes
                assert.strictEqual(results[i].stateChanges.length, 2,
                    'Execution ' + i + ' should have 2 state changes, got ' +
                    results[i].stateChanges.length);
                // Verify state changes belong to this execution only
                const ownerChange = results[i].stateChanges.find(c => c.key === 'owner');
                assert.strictEqual(ownerChange.value, String(i + 1),
                    'State should belong to execution ' + i);
            }
        }
    });

    it('CHAOS-503: mixed success/failure concurrent executions', async function() {
        this.timeout(60000);
        const vm = createVM({ gasCeiling: 500 });

        const goodCode = `module.exports = function(xchain) { return 'ok'; };`;
        const badCode = `module.exports = function(xchain) {
            while(true) {} // gas exhaustion
        };`;
        const revertCode = `module.exports = function(xchain) {
            xchain.state.set('temp', 'val');
            xchain.revert('intentional');
        };`;

        const promises = [];
        for (let i = 0; i < 15; i++) {
            if (i % 3 === 0) promises.push(execute(vm, goodCode));
            else if (i % 3 === 1) promises.push(execute(vm, badCode));
            else promises.push(execute(vm, revertCode));
        }

        const results = await Promise.all(promises);

        let successes = 0, failures = 0;
        for (let i = 0; i < results.length; i++) {
            checkResultShape(results[i]);
            if (results[i].success) {
                successes++;
            } else {
                failures++;
                checkAtomicity(results[i]);
            }
        }

        // Expect 5 successes (every 3rd), 10 failures
        assert.strictEqual(successes, 5, 'Expected 5 successes, got ' + successes);
        assert.strictEqual(failures, 10, 'Expected 10 failures, got ' + failures);
    });

    it('CHAOS-504: concurrent executions with different contracts', async function() {
        this.timeout(60000);
        const vm = createVM();

        const contracts = [
            `module.exports = function(xchain) { return 'a'; };`,
            `module.exports = function(xchain) { xchain.state.set('k','v'); return 'b'; };`,
            `module.exports = function(xchain) {
                xchain.emit.send({destination:'x',tick:'T',quantity:'1'});
                return 'c';
            };`,
            `module.exports = function(xchain) { return xchain.math.add('1','2'); };`,
            `module.exports = function(xchain) { xchain.log('hello'); return 'd'; };`,
        ];

        const promises = contracts.map(code => execute(vm, code));
        const results = await Promise.all(promises);

        for (let i = 0; i < results.length; i++) {
            checkResultShape(results[i]);
            assert.strictEqual(results[i].success, true,
                'Contract ' + i + ' should succeed: ' + results[i].error);
        }

        // Verify each returned its own value
        const returns = results.map(r => JSON.parse(r.returnValue));
        assert.deepStrictEqual(returns, ['a', 'b', 'c', '3', 'd']);
    });

    it('CHAOS-505: VM usable after concurrent exhaustion', async function() {
        this.timeout(60000);
        const vm = createVM({ maxMemory: 8 });

        // 10 concurrent OOM attempts
        const oomCode = `module.exports = function(xchain) {
            var a = []; while(true) { a.push(new Array(100000).fill('x')); }
        };`;
        const promises = Array.from({ length: 10 }, () => execute(vm, oomCode));
        await Promise.all(promises);

        // Recovery
        await chaosAssertions.assertRecovery(vm);
    });
});
