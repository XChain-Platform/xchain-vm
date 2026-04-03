/*********************************************************************
 * E2E Tests: Oracle & Cross-Chain Integration
 * Scenarios: E2E-090 through E2E-092
 ********************************************************************/

const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertReverted, assertReturnValue, assertEmittedActions
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Oracle & Cross-Chain', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-090: Oracle price read in contract ---
    describe('E2E-090: Oracle price conditional logic', function() {
        it('should emit SEND when price is above threshold', async function() {
            // Seed oracle: BTC/USD at 60000, snapshot age = 5
            h.ledger.seedOracle('BTC/USD', '60000', 5);

            const code = h.loadContract('oracle_conditional.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:90',
                params: ['TEST', '50000', 'BTC/USD']
            });
            h.ledger.creditContractBalance('C:BTC:90', 'TEST', '1000');

            const result = await h.execute({
                contractAddress: 'C:BTC:90', method: 'checkAndSend',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
            assertReturnValue(result, 'above_threshold');
            assertEmittedActions(result, [
                { action: 'SEND', params: { tick: 'TEST', quantity: '100' } }
            ]);
        });

        it('should not emit SEND when price is below threshold', async function() {
            // Seed oracle: BTC/USD at 40000 (below 50000 threshold)
            h.ledger.seedOracle('BTC/USD', '40000', 5);

            const code = h.loadContract('oracle_conditional.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:90b',
                params: ['TEST', '50000', 'BTC/USD']
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:90b', method: 'checkAndSend',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
            assertReturnValue(result, 'below_threshold');
            assert.strictEqual(result.emittedActions.length, 0, 'No SEND below threshold');
        });
    });

    // --- E2E-091: Oracle snapshot age check ---
    describe('E2E-091: Stale oracle data rejection', function() {
        it('should revert when oracle data is too stale', async function() {
            // Seed oracle with high snapshot age (stale)
            h.ledger.seedOracle('BTC/USD', '50000', 200);

            const code = h.loadContract('oracle_conditional.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:91',
                params: ['TEST', '50000', 'BTC/USD']
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:91', method: 'checkAndSend',
                params: [], caller: 'user1'
            });
            assertReverted(result, 'oracle data too stale');
        });

        it('should succeed with fresh oracle data', async function() {
            h.ledger.seedOracle('BTC/USD', '60000', 3);

            const code = h.loadContract('oracle_conditional.js');
            await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:91b',
                params: ['TEST', '50000', 'BTC/USD']
            });
            h.ledger.creditContractBalance('C:BTC:91b', 'TEST', '1000');

            const result = await h.execute({
                contractAddress: 'C:BTC:91b', method: 'checkAndSend',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
        });
    });

    // --- E2E-092: Cross-chain attestation read ---
    describe('E2E-092: Cross-chain attestation', function() {
        it('should read attestation and branch on settlement status', async function() {
            // Seed cross-chain data
            h.ledger.seedCrossChain('LTC', 42, { status: 'confirmed', settled: true });
            h.ledger.seedCrossChain('DOGE', 10, { status: 'pending', settled: false });

            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    checkSettlement: function(xchain) {
                        var chain = xchain.getInputParam(0);
                        var idx = parseInt(xchain.getInputParam(1));
                        var settled = xchain.crossChain.isSettled(chain, idx);
                        var attestation = xchain.crossChain.getAttestation(chain, idx);
                        xchain.log('chain:', chain, 'settled:', settled);
                        if (settled) {
                            xchain.emit.send({ destination: xchain.getSourceAddress(), tick: 'REWARD', quantity: '10' });
                            return { settled: true, status: attestation ? attestation.status : null };
                        }
                        return { settled: false };
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:92'
            });
            h.ledger.creditContractBalance('C:BTC:92', 'REWARD', '1000');

            // Check settled attestation (LTC:42)
            const r1 = await h.execute({
                contractAddress: 'C:BTC:92', method: 'checkSettlement',
                params: ['LTC', '42'], caller: 'user1'
            });
            assertSuccess(r1);
            const v1 = JSON.parse(r1.returnValue);
            assert.strictEqual(v1.settled, true);
            assert.strictEqual(v1.status, 'confirmed');
            assert.strictEqual(r1.emittedActions.length, 1);

            // Check unsettled attestation (DOGE:10)
            const r2 = await h.execute({
                contractAddress: 'C:BTC:92', method: 'checkSettlement',
                params: ['DOGE', '10'], caller: 'user1'
            });
            assertSuccess(r2);
            const v2 = JSON.parse(r2.returnValue);
            assert.strictEqual(v2.settled, false);
            assert.strictEqual(r2.emittedActions.length, 0, 'No emission for unsettled');
        });

        it('should return null for non-existent attestation', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    check: function(xchain) {
                        return xchain.crossChain.getAttestation('BTC', 999);
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:92b'
            });

            const r = await h.execute({
                contractAddress: 'C:BTC:92b', method: 'check',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assert.strictEqual(r.returnValue, 'null');
        });
    });
});
