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
 * E2E Tests: Determinism Verification
 * Scenarios: E2E-080 through E2E-082
 ********************************************************************/

const assert = require('assert');
const crypto = require('crypto');
const { E2EHarness } = require('./helpers/harness.js');
const { assertSuccess } = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

function hashResult(result) {
    const normalized = JSON.stringify({
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed,
        returnValue: result.returnValue,
        stateChanges: result.stateChanges,
        stateDeletes: result.stateDeletes,
        emittedActions: result.emittedActions,
        logs: result.logs
    });
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

(XChainVM ? describe : describe.skip)('E2E: Determinism', function() {

    // --- E2E-080: Identical results across re-execution ---
    describe('E2E-080: Identical results across re-execution', function() {
        it('should produce byte-identical results for 10 consecutive runs', async function() {
            const code = `module.exports = function(xchain) {
                var a = xchain.math.add('100', '200');
                var b = xchain.math.multiply(a, '3');
                var c = xchain.math.divide(b, '7');
                xchain.state.set('result', c);
                xchain.emit.send({ destination: 'addr1', tick: 'TEST', quantity: c });
                xchain.log('computed:', c);
                return c;
            };`;

            const hashes = [];
            for (let i = 0; i < 10; i++) {
                const h = new E2EHarness(XChainVM);
                h.seedBalance('deployer', 'XCHAIN', '1000000');
                h.ledger.deployContract('C:BTC:80', code, 'deployer', 1);
                h.ledger.creditContractBalance('C:BTC:80', 'TEST', '10000');

                const result = await h.execute({
                    contractAddress: 'C:BTC:80', method: 'default',
                    params: [], caller: 'deployer',
                    blockContext: { height: 100, timestamp: 1700000000, hash: 'deterministic_hash' }
                });
                assertSuccess(result);
                hashes.push(hashResult(result));
            }

            // All hashes must be identical
            for (let i = 1; i < hashes.length; i++) {
                assert.strictEqual(hashes[i], hashes[0],
                    `Run ${i} produced different result hash: ${hashes[i]} vs ${hashes[0]}`);
            }
        });
    });

    // --- E2E-081: Determinism with math operations ---
    describe('E2E-081: Math determinism', function() {
        it('should produce identical math results with high-precision operations', async function() {
            const code = `module.exports = function(xchain) {
                var results = [];
                // Classic floating-point trap: 0.1 + 0.2
                results.push(xchain.math.add('0.1', '0.2'));
                // Large number multiplication
                results.push(xchain.math.multiply('999999999999999999', '888888888888888888'));
                // Division with many decimals
                results.push(xchain.math.divide('1', '3'));
                // Chain of operations
                var x = '1000000';
                for (var i = 0; i < 20; i++) {
                    x = xchain.math.divide(xchain.math.multiply(x, '99'), '100');
                }
                results.push(x);
                return results;
            };`;

            const results = [];
            for (let i = 0; i < 5; i++) {
                const h = new E2EHarness(XChainVM);
                h.seedBalance('deployer', 'XCHAIN', '1000000');
                h.ledger.deployContract('C:BTC:81', code, 'deployer', 1);

                const result = await h.execute({
                    contractAddress: 'C:BTC:81', method: 'default',
                    params: [], caller: 'deployer',
                    blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' }
                });
                assertSuccess(result);
                results.push(result.returnValue);
            }

            for (let i = 1; i < results.length; i++) {
                assert.strictEqual(results[i], results[0],
                    `Math results differ between run 0 and run ${i}`);
            }

            // Verify 0.1 + 0.2 = 0.3 exactly (not 0.30000000000000004)
            const vals = JSON.parse(results[0]);
            assert.strictEqual(vals[0], '0.3', 'Expected 0.1 + 0.2 = "0.3"');
        });
    });

    // --- E2E-082: Determinism across block replay ---
    describe('E2E-082: Block replay determinism', function() {
        it('should produce identical final state after replaying blocks', async function() {
            const code = `module.exports = {
                initialize: function(xchain) {
                    xchain.state.set('counter', '0');
                    xchain.state.set('sum', '0');
                },
                process: function(xchain) {
                    var counter = xchain.state.get('counter');
                    var sum = xchain.state.get('sum');
                    var height = xchain.getBlockHeight();
                    counter = xchain.math.add(counter, '1');
                    sum = xchain.math.add(sum, String(height));
                    xchain.state.set('counter', counter);
                    xchain.state.set('sum', sum);
                    xchain.emit.send({ destination: 'collector', tick: 'T', quantity: counter });
                    return { counter: counter, sum: sum };
                }
            };`;

            async function runSimulation() {
                const h = new E2EHarness(XChainVM);
                h.seedBalance('deployer', 'XCHAIN', '1000000');

                await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:82' });
                h.ledger.creditContractBalance('C:BTC:82', 'T', '100000');

                const results = [];
                for (let block = 0; block < 10; block++) {
                    h.mineBlock();
                    const r = await h.execute({
                        contractAddress: 'C:BTC:82', method: 'process',
                        params: [], caller: 'deployer'
                    });
                    results.push(hashResult(r));
                }

                return {
                    finalState: h.ledger.getContractState('C:BTC:82'),
                    resultHashes: results
                };
            }

            // Run simulation twice
            const sim1 = await runSimulation();
            const sim2 = await runSimulation();

            // Final state must match
            assert.deepStrictEqual(sim1.finalState, sim2.finalState,
                'Final state should be identical after replay');

            // Each block's result must match
            for (let i = 0; i < sim1.resultHashes.length; i++) {
                assert.strictEqual(sim1.resultHashes[i], sim2.resultHashes[i],
                    `Block ${i} result hash differs between simulations`);
            }
        });
    });
});
