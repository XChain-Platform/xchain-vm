/*********************************************************************
 * E2E Tests: Resource Limit Enforcement
 * Scenarios: E2E-040 through E2E-046
 ********************************************************************/

const assert = require('assert');
const { E2EHarness } = require('./helpers/harness.js');
const {
    assertSuccess, assertFailed, assertOutOfGas, assertOutOfMemory,
    assertReturnValue, assertContractState
} = require('./helpers/assertions.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); }
catch (e) { console.log('Skipping E2E tests — isolated-vm not available'); }

(XChainVM ? describe : describe.skip)('E2E: Resource Limits', function() {

    let h;

    beforeEach(function() {
        h = new E2EHarness(XChainVM);
        h.seedBalance('deployer', 'XCHAIN', '1000000');
        h.seedBalance('user1', 'XCHAIN', '1000000');
    });

    // --- E2E-040: Gas exhaustion ---
    describe('E2E-040: Gas exhaustion (infinite loop)', function() {
        it('should terminate with out_of_gas and discard state', async function() {
            const hLow = new E2EHarness(XChainVM, { gasCeiling: 5000 });
            hLow.seedBalance('deployer', 'XCHAIN', '1000000');

            await hLow.deploy({
                code: `module.exports = {
                    initialize: function(xchain) { xchain.state.set('val', '0'); },
                    loop: function(xchain) {
                        xchain.state.set('val', 'should_not_persist');
                        while (true) { }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:40'
            });

            const result = await hLow.execute({
                contractAddress: 'C:BTC:40', method: 'loop',
                params: [], caller: 'deployer'
            });
            assertOutOfGas(result);
            assert(result.gasUsed > 0, 'Should have used some gas');
            // State should not have been persisted
            assertContractState(hLow.ledger, 'C:BTC:40', 'val', '0');
        });

        it('should remain stable after gas exhaustion', async function() {
            const hLow = new E2EHarness(XChainVM, { gasCeiling: 5000 });
            hLow.seedBalance('deployer', 'XCHAIN', '1000000');

            await hLow.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    loop: function(xchain) { while(true) {} },
                    ok: function(xchain) { return 'stable'; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:40b'
            });

            // Gas exhaust
            await hLow.execute({
                contractAddress: 'C:BTC:40b', method: 'loop',
                params: [], caller: 'deployer'
            });

            // System should still work
            const r2 = await hLow.execute({
                contractAddress: 'C:BTC:40b', method: 'ok',
                params: [], caller: 'deployer'
            });
            assertSuccess(r2);
            assertReturnValue(r2, 'stable');
        });
    });

    // --- E2E-041: Memory exhaustion ---
    describe('E2E-041: Memory exhaustion (OOM)', function() {
        it('should terminate with out_of_memory or timeout and discard state', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    oom: function(xchain) {
                        var arr = [];
                        while (true) { arr.push(new Array(100000)); }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:41'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:41', method: 'oom',
                params: [], caller: 'user1'
            });
            assert.strictEqual(result.success, false);
            // On some systems, wall-clock timeout fires before OOM — both are valid
            assert(
                result.error.includes('out_of_memory') || result.error.includes('timeout'),
                `Expected out_of_memory or timeout, got: ${result.error}`
            );
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should remain stable after OOM/timeout', async function() {
            // Deploy two separate contracts
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    oom: function(xchain) {
                        var arr = [];
                        while (true) { arr.push(new Array(100000)); }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:41a'
            });

            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    ok: function(xchain) { return 'still alive'; }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:41b'
            });

            // OOM/timeout on first
            await h.execute({
                contractAddress: 'C:BTC:41a', method: 'oom',
                params: [], caller: 'user1'
            });

            // Second contract should work fine
            const r = await h.execute({
                contractAddress: 'C:BTC:41b', method: 'ok',
                params: [], caller: 'user1'
            });
            assertSuccess(r);
            assertReturnValue(r, 'still alive');
        });
    });

    // --- E2E-042: Wall-clock timeout ---
    describe('E2E-042: Wall-clock timeout', function() {
        it('should terminate on timeout', async function() {
            // Use a very short timeout
            const hShort = new E2EHarness(XChainVM, {
                gasCeiling: 100000000, // Very high gas so it won't gas-out first
                limits: { maxCpuTimeMs: 500 }
            });
            hShort.seedBalance('deployer', 'XCHAIN', '1000000');

            await hShort.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    spin: function(xchain) {
                        // Busy loop that uses minimal gas per iteration but lots of wall time
                        var x = 0;
                        while (true) { x++; }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:42'
            });

            const result = await hShort.execute({
                contractAddress: 'C:BTC:42', method: 'spin',
                params: [], caller: 'deployer'
            });
            // Should be either timeout or out_of_gas (depending on which triggers first)
            assert.strictEqual(result.success, false);
            assert(
                result.error.includes('timeout') || result.error.includes('out_of_gas'),
                'Expected timeout or gas error, got: ' + result.error
            );
        });
    });

    // --- E2E-043: Emission flood ---
    describe('E2E-043: Emission flood (>50 actions)', function() {
        it('should fail when exceeding emission cap', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    flood: function(xchain) {
                        for (var i = 0; i < 51; i++) {
                            xchain.emit.send({ destination: 'addr', tick: 'T', quantity: '1' });
                        }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:43'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:43', method: 'flood',
                params: [], caller: 'user1'
            });
            assertFailed(result);
            // All 50 emissions should be discarded (atomicity)
            assert.strictEqual(result.emittedActions.length, 0);
        });
    });

    // --- E2E-044: State key flood ---
    describe('E2E-044: State key flood (>10000 keys)', function() {
        it('should fail when exceeding state key limit', async function() {
            const hSmall = new E2EHarness(XChainVM, { limits: { maxStateKeys: 100 } });
            hSmall.seedBalance('deployer', 'XCHAIN', '1000000');

            await hSmall.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    flood: function(xchain) {
                        for (var i = 0; i < 150; i++) {
                            xchain.state.set('key_' + i, 'val');
                        }
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:44'
            });

            const result = await hSmall.execute({
                contractAddress: 'C:BTC:44', method: 'flood',
                params: [], caller: 'deployer'
            });
            assertFailed(result);
            assert.strictEqual(result.stateChanges.length, 0, 'State changes should be discarded');
        });
    });

    // --- E2E-045: State value size exceeded ---
    describe('E2E-045: Oversized state value', function() {
        it('should fail when writing value exceeding 64KB', async function() {
            await h.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    bigWrite: function(xchain) {
                        var big = '';
                        for (var i = 0; i < 70000; i++) big += 'x';
                        xchain.state.set('big', big);
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:45'
            });

            const result = await h.execute({
                contractAddress: 'C:BTC:45', method: 'bigWrite',
                params: [], caller: 'user1'
            });
            assertFailed(result);
        });
    });

    // --- E2E-046: Sequential resource reset ---
    describe('E2E-046: Gas resets between executions', function() {
        it('should give each execution a fresh gas budget', async function() {
            const hLow = new E2EHarness(XChainVM, { gasCeiling: 10000 });
            hLow.seedBalance('deployer', 'XCHAIN', '1000000');

            await hLow.deploy({
                code: `module.exports = {
                    initialize: function(xchain) {},
                    work: function(xchain) {
                        for (var i = 0; i < 100; i++) { var x = i * i; }
                        return 'done';
                    }
                };`,
                deployer: 'deployer', contractAddress: 'C:BTC:46'
            });

            // First execution uses gas but succeeds
            const r1 = await hLow.execute({
                contractAddress: 'C:BTC:46', method: 'work',
                params: [], caller: 'deployer'
            });
            assertSuccess(r1);
            const gas1 = r1.gasUsed;

            // Second execution should get a fresh gas budget (not cumulative)
            const r2 = await hLow.execute({
                contractAddress: 'C:BTC:46', method: 'work',
                params: [], caller: 'deployer'
            });
            assertSuccess(r2);
            // Gas should be roughly the same (fresh budget, not accumulated)
            assert(Math.abs(r2.gasUsed - gas1) < gas1 * 0.1,
                `Gas should reset: first=${gas1}, second=${r2.gasUsed}`);
        });
    });
});
