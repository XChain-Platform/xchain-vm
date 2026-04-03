/*********************************************************************
 * E2E Tests: Contract Deployment & Basic Execution
 * Scenarios: E2E-001 through E2E-005
 ********************************************************************/

const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertFailed, assertReverted, assertReturnValue,
    assertContractState, assertEmittedActions, assertLogsContain
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Deploy & Execute', function() {

    let h; // harness

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-001: Deploy simple contract and execute ---
    describe('E2E-001: Deploy and execute simple contract', function() {
        it('should deploy, initialize state, and execute a SEND', async function() {
            const code = h.loadContract('token_sender.js');
            const deploy = await h.deploy({
                code, deployer: 'deployer', contractAddress: 'C:BTC:1',
                params: ['TEST']
            });
            assertSuccess(deploy.result);

            // Verify state was initialized
            assertContractState(h.ledger, 'C:BTC:1', 'owner', 'deployer');
            assertContractState(h.ledger, 'C:BTC:1', 'token', 'TEST');
            assertContractState(h.ledger, 'C:BTC:1', 'sends', '0');

            // Deposit tokens to contract custody so SEND can work
            h.seedBalance('C:BTC:1', 'TEST', '0');
            h.ledger.creditContractBalance('C:BTC:1', 'TEST', '1000');

            // Execute send
            const result = await h.execute({
                contractAddress: 'C:BTC:1', method: 'send',
                params: ['user1', '50'], caller: 'deployer'
            });
            assertSuccess(result);
            assertReturnValue(result, 'ok');
            assertEmittedActions(result, [
                { action: 'SEND', params: { destination: 'user1', tick: 'TEST', quantity: '50' } }
            ]);
            assertLogsContain(result, 'sent 50 to user1');

            // Verify state updated
            assertContractState(h.ledger, 'C:BTC:1', 'sends', '1');
        });
    });

    // --- E2E-002: Deploy with invalid syntax ---
    describe('E2E-002: Deploy with invalid syntax', function() {
        it('should reject deployment of syntactically invalid code', async function() {
            const result = await h.deploy({
                code: 'function { invalid }',
                deployer: 'deployer', contractAddress: 'C:BTC:2'
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('syntax'), 'Expected syntax error: ' + result.error);
            // No contract should be stored
            assert.strictEqual(h.ledger.getContract('C:BTC:2'), null);
        });
    });

    // --- E2E-003: Deploy exceeding code size limit ---
    describe('E2E-003: Deploy exceeding code size limit', function() {
        it('should reject oversized contract code', async function() {
            const bigCode = 'var x = "' + 'a'.repeat(70000) + '"; module.exports = function() { return x; };';
            const result = await h.deploy({
                code: bigCode,
                deployer: 'deployer', contractAddress: 'C:BTC:3'
            });
            assert.strictEqual(result.success, false);
        });
    });

    // --- E2E-004: Execute non-existent contract ---
    describe('E2E-004: Execute non-existent contract', function() {
        it('should fail gracefully', async function() {
            const result = await h.execute({
                contractAddress: 'C:BTC:999', method: 'default',
                params: [], caller: 'user1'
            });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('contract not found'));
        });
    });

    // --- E2E-005: Execute with method routing ---
    describe('E2E-005: Execute with method routing', function() {
        it('should invoke different methods on object-export contract', async function() {
            const code = h.loadContract('multi_method.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:5' });

            // Call setValue
            const r1 = await h.execute({
                contractAddress: 'C:BTC:5', method: 'setValue',
                params: ['hello'], caller: 'deployer'
            });
            assertSuccess(r1);
            assertReturnValue(r1, 'hello');
            assertContractState(h.ledger, 'C:BTC:5', 'value', 'hello');

            // Call getValue
            const r2 = await h.execute({
                contractAddress: 'C:BTC:5', method: 'getValue',
                params: [], caller: 'user1'
            });
            assertSuccess(r2);
            assertReturnValue(r2, 'hello');
        });

        it('should fail on unknown method', async function() {
            const code = h.loadContract('multi_method.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:5b' });

            const result = await h.execute({
                contractAddress: 'C:BTC:5b', method: 'nonExistent',
                params: [], caller: 'user1'
            });
            assertFailed(result, 'unknown method');
        });

        it('should enforce caller-based access control', async function() {
            const code = h.loadContract('multi_method.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:5c' });

            // Owner can call onlyOwner
            const r1 = await h.execute({
                contractAddress: 'C:BTC:5c', method: 'onlyOwner',
                params: [], caller: 'deployer'
            });
            assertSuccess(r1);
            assertReturnValue(r1, 'authorized');

            // Non-owner cannot
            const r2 = await h.execute({
                contractAddress: 'C:BTC:5c', method: 'onlyOwner',
                params: [], caller: 'user1'
            });
            assertReverted(r2, 'not owner');
        });

        it('should handle single-function export (no method routing)', async function() {
            const code = h.loadContract('simple_func.js');
            await h.deploy({ code, deployer: 'deployer', contractAddress: 'C:BTC:5d' });

            const result = await h.execute({
                contractAddress: 'C:BTC:5d', method: 'default',
                params: [], caller: 'user1'
            });
            assertSuccess(result);
            assertReturnValue(result, 'hello from contract');
            assertLogsContain(result, 'executed');
        });
    });
});
