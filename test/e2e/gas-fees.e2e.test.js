/*********************************************************************
 * E2E Tests: Fee Accounting & Gas Schedule
 * Scenarios: E2E-070 through E2E-073
 ********************************************************************/

const assert = require('assert');
const { E2EHarness, GAS_SCHEDULE } = require('./helpers/harness.js');
const {
    assertSuccess, assertFailed, assertBalance, assertGasInRange
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Gas Fees', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '50000');
    });

    // --- E2E-070: Gas fee deduction on success ---
    describe('E2E-070: Fee deduction on successful execution', function() {
        it('should deduct gas fee from caller XCHAIN balance', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    simple: function(xchain) { return 'ok'; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:70'
            });

            const balanceBefore = h.ledger.getBalance('user1', 'XCHAIN');

            const result = await h.execute({
                contractAddress: 'C:BTC:70', method: 'simple',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
            assert(result.gasUsed > 0, 'Should use some gas');

            const balanceAfter = h.ledger.getBalance('user1', 'XCHAIN');
            const deducted = parseInt(balanceBefore) - parseInt(balanceAfter);
            assert.strictEqual(deducted, result.gasUsed,
                `Expected ${result.gasUsed} deducted, got ${deducted}`);
        });

        it('should credit gas fee to GAS_ADDRESS', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    simple: function(xchain) { return 'ok'; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:70b'
            });

            const gasAddrBefore = h.ledger.getBalance('GAS_ADDRESS', 'XCHAIN') || '0';

            const result = await h.execute({
                contractAddress: 'C:BTC:70b', method: 'simple',
                params: [], caller: 'user1'
            });

            const gasAddrAfter = h.ledger.getBalance('GAS_ADDRESS', 'XCHAIN') || '0';
            const credited = parseInt(gasAddrAfter) - parseInt(gasAddrBefore);
            assert.strictEqual(credited, result.gasUsed);
        });
    });

    // --- E2E-071: Gas fee deduction on failure ---
    describe('E2E-071: Fee deduction on failed execution', function() {
        it('should still charge gas consumed before revert', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    failAfterWork: function(xchain) {
                        for (var i = 0; i < 50; i++) { var x = i; }
                        xchain.state.set('temp', 'val');
                        xchain.revert('intentional');
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:71'
            });

            const balanceBefore = parseInt(h.ledger.getBalance('user1', 'XCHAIN'));

            const result = await h.execute({
                contractAddress: 'C:BTC:71', method: 'failAfterWork',
                params: [], caller: 'user1'
            });
            assertFailed(result, 'intentional');
            assert(result.gasUsed > 0, 'Should charge partial gas');

            const balanceAfter = parseInt(h.ledger.getBalance('user1', 'XCHAIN'));
            assert(balanceBefore > balanceAfter,
                'Balance should decrease even on failure');
        });
    });

    // --- E2E-072: Gas costs for different operation types ---
    describe('E2E-072: Gas cost breakdown by operation type', function() {
        it('should charge correct gas for state reads, writes, and emissions', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    measured: function(xchain) {
                        // 2 state writes (200 each = 400)
                        xchain.state.set('a', '1');
                        xchain.state.set('b', '2');
                        // 1 state read (100)
                        xchain.state.get('a');
                        // 1 emission (500)
                        xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:72'
            });

            h.ledger.creditContractBalance('C:BTC:72', 'T', '100');

            const result = await h.execute({
                contractAddress: 'C:BTC:72', method: 'measured',
                params: [], caller: 'user1'
            });
            assertSuccess(result);

            // Minimum gas: 2*200 + 1*100 + 1*500 = 1000 (plus computation gas)
            const minExpectedGas = (2 * GAS_SCHEDULE.VM_STATE_WRITE) +
                                   (1 * GAS_SCHEDULE.VM_STATE_READ) +
                                   (1 * GAS_SCHEDULE.VM_EMISSION);
            assert(result.gasUsed >= minExpectedGas,
                `Expected at least ${minExpectedGas} gas, got ${result.gasUsed}`);
        });
    });

    // --- E2E-073: Deploy gas cost ---
    describe('E2E-073: Deploy charges gas', function() {
        it('should charge gas for the initialize execution', async function() {
            const balanceBefore = parseInt(h.ledger.getBalance('deployer', 'XCHAIN'));

            const deployResult = await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {
                        xchain.state.set('name', 'my_contract');
                        xchain.state.set('version', '1');
                    },
                    run: function(xchain) { return 'ok'; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:73'
            });
            assertSuccess(deployResult);
            assert(deployResult.gasUsed > 0, 'Deploy should consume gas');

            const balanceAfter = parseInt(h.ledger.getBalance('deployer', 'XCHAIN'));
            assert(balanceBefore > balanceAfter, 'Deploy should deduct gas fee');
        });
    });
});
