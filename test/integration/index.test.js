const assert = require('assert');

let XChainVM, vmWorking = false;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping index tests — isolated-vm not available: ' + e.message);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
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

// Probe whether full VM execution works (ExternalCopy of math may fail on some ivm versions)
if (XChainVM) {
    try {
        const probe = createVM();
        const p = probe.execute({
            code: 'module.exports = function(xchain) { return 1; };',
            state: {}, method: 'default', params: [],
            caller: 'probe', contractAddress: 'C:BTC:0',
            blockContext: { height: 1, timestamp: 0, hash: '0' }
        });
        // Synchronous check not possible; mark as potentially working.
        // The before() hook below will do the actual async check.
        vmWorking = true;
    } catch (e) {
        console.log('Skipping index tests — VM probe failed: ' + e.message);
    }
}

function execute(vm, code, opts) {
    return vm.execute({
        code: code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: opts?.caller || 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: opts?.balances,
        tokenInfo: opts?.tokenInfo,
        oracleData: opts?.oracleData,
        crossChainData: opts?.crossChainData,
        contractIndex: opts?.contractIndex
    });
}

(vmWorking ? describe : describe.skip)('XChainVM', function() {

    let vm;
    before(async function() {
        vm = createVM();
        // Verify the full VM pipeline works (ExternalCopy of math API may fail)
        const probe = await vm.execute({
            code: 'module.exports = function(xchain) { return 1; };',
            state: {}, method: 'default', params: [],
            caller: 'probe', contractAddress: 'C:BTC:0',
            blockContext: { height: 1, timestamp: 0, hash: '0' }
        });
        if (!probe.success) {
            console.log('Skipping XChainVM tests — VM execution not functional: ' + probe.error);
            this.skip();
        }
    });

    describe('result structure', function() {
        it('should return all 8 fields on success', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return 42; };');
            assert.strictEqual(typeof result.success, 'boolean');
            assert.strictEqual(result.error, null);
            assert.strictEqual(typeof result.gasUsed, 'number');
            assert(Array.isArray(result.stateChanges));
            assert(Array.isArray(result.stateDeletes));
            assert(Array.isArray(result.emittedActions));
            assert(Array.isArray(result.logs));
            assert('returnValue' in result);
        });

        it('should return all 8 fields on failure', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { xchain.revert("fail"); };');
            assert.strictEqual(result.success, false);
            assert.strictEqual(typeof result.error, 'string');
            assert.strictEqual(typeof result.gasUsed, 'number');
            assert.strictEqual(result.returnValue, null);
            assert(Array.isArray(result.stateChanges));
            assert(Array.isArray(result.stateDeletes));
            assert(Array.isArray(result.emittedActions));
            assert(Array.isArray(result.logs));
        });
    });

    describe('atomicity', function() {
        it('should discard state and emissions on revert', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.state.set('a', '1');
                xchain.state.set('b', '2');
                xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                xchain.log('before revert');
                xchain.revert('rollback');
            };`);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.stateDeletes.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
            assert.strictEqual(result.logs.length, 1);
            assert.strictEqual(result.logs[0], 'before revert');
        });

        it('should discard state and emissions on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 500 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                xchain.state.set('a', '1');
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert.strictEqual(result.success, false);
            assert(result.error.includes('out_of_gas'));
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should discard state and emissions on contract error', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.state.set('key', 'val');
                xchain.emit.send({ destination: 'x', tick: 'T', quantity: '1' });
                throw new Error('contract crash');
            };`);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.stateChanges.length, 0);
            assert.strictEqual(result.emittedActions.length, 0);
        });

        it('should preserve logs on gas exhaustion', async function() {
            const vm2 = createVM({ gasCeiling: 800 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                xchain.log('logged before gas out');
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert.strictEqual(result.success, false);
            assert(result.logs.length >= 1);
        });
    });

    describe('return value', function() {
        it('should serialize string return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return "hello"; };');
            assert.strictEqual(JSON.parse(result.returnValue), 'hello');
        });

        it('should serialize number return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return 42; };');
            assert.strictEqual(JSON.parse(result.returnValue), 42);
        });

        it('should serialize object return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return { a: 1, b: "two" }; };');
            assert.deepStrictEqual(JSON.parse(result.returnValue), { a: 1, b: 'two' });
        });

        it('should serialize array return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return [1, 2, 3]; };');
            assert.deepStrictEqual(JSON.parse(result.returnValue), [1, 2, 3]);
        });

        it('should serialize boolean return value', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return true; };');
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should return null for undefined return', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { };');
            assert.strictEqual(result.returnValue, null);
        });

        it('should return "null" for null return', async function() {
            const result = await execute(vm, 'module.exports = function(xchain) { return null; };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should truncate return value exceeding 64KB', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                var s = '';
                for (var i = 0; i < 70000; i++) s += 'x';
                return s;
            };`);
            assert.strictEqual(result.success, true);
            assert(result.returnValue.length <= 65536);
        });
    });

    describe('method routing', function() {
        it('should call default export function (ignore method param)', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return "func_export"; };',
                { method: 'anything' }
            );
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'func_export');
        });

        it('should call named method on object export', async function() {
            const result = await execute(vm, `module.exports = {
                foo: function(xchain) { return 'foo_called'; },
                bar: function(xchain) { return 'bar_called'; }
            };`, { method: 'bar' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'bar_called');
        });

        it('should error on unknown method for object export', async function() {
            const result = await execute(vm, `module.exports = {
                foo: function(xchain) { return 1; }
            };`, { method: 'missing' });
            assert.strictEqual(result.success, false);
            assert(result.error.includes('unknown method'));
        });

        it('should error when contract exports non-function non-object', async function() {
            const result = await execute(vm, 'module.exports = 42;');
            assert.strictEqual(result.success, false);
            assert(result.error.includes('must export'));
        });
    });

    describe('error classification', function() {
        it('should prefix revert errors with "revert:"', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.revert("bad"); };');
            assert(result.error.startsWith('revert:'));
        });

        it('should prefix gas errors with "out_of_gas:"', async function() {
            const vm2 = createVM({ gasCeiling: 50 });
            const result = await execute(vm2, `module.exports = function(xchain) {
                for (var i = 0; i < 100000; i++) { }
            };`);
            assert(result.error.startsWith('out_of_gas:'));
        });

        it('should prefix generic errors with "error:"', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("oops"); };');
            assert(result.error.startsWith('error:'));
        });

        it('should use "revert: reverted" for revert() with no reason', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.revert(); };');
            assert(result.error.includes('revert: reverted'));
        });

        it('should use "revert: requirement failed" for require(false) with no reason', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { xchain.require(false); };');
            assert(result.error.includes('revert: requirement failed'));
        });

        it('should not misclassify contract-thrown \\x03GAS error as gas exhaustion', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("\\x03GAS:999:100"); };');
            assert(result.error.startsWith('error:'), 'expected generic error, got: ' + result.error);
        });

        it('should not misclassify contract-thrown \\x03REVERT as revert', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };');
            assert(result.error.startsWith('error:'), 'expected generic error, got: ' + result.error);
        });
    });

    describe('context accessors (extended)', function() {
        it('should provide block timestamp', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBlockTimestamp(); };',
                { blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 1700000000);
        });

        it('should provide block hash', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBlockHash(); };',
                { blockContext: { height: 100, timestamp: 1700000000, hash: 'myhash' } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 'myhash');
        });

        it('should provide input param count', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParamCount(); };',
                { params: ['a', 'b', 'c'] }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 3);
        });

        it('should return null for out-of-bounds getInputParam', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParam(5); };',
                { params: ['a', 'b'] }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return 0 for getInputParamCount with no params', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParamCount(); };',
                { params: [] }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 0);
        });
    });

    describe('getBalance / getTokenInfo', function() {
        it('should return balance for known address and tick', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("addr1", "TEST"); };',
                { balances: { addr1: { TEST: '500' } } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '500');
        });

        it('should return null for unknown address', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("unknown", "TEST"); };',
                { balances: { addr1: { TEST: '500' } } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return null when no balances provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBalance("addr", "T"); };');
            // balances defaults to {} in execute(), so getBalance returns null
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return token info for known tick', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getTokenInfo("TEST"); };',
                { tokenInfo: { TEST: { supply: '1000', decimals: 8 } } }
            );
            const info = JSON.parse(result.returnValue);
            assert.strictEqual(info.supply, '1000');
            assert.strictEqual(info.decimals, 8);
        });

        it('should return null for unknown token', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getTokenInfo("MISSING"); };',
                { tokenInfo: { TEST: { supply: '1000' } } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });
    });

    describe('oracle', function() {
        it('should return price from oracle data', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPrice("BTC/USD"); };',
                { oracleData: { getPrice: (pair) => pair === 'BTC/USD' ? '50000' : null, getSnapshotAge: () => 60, getPriceAtRound: () => null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '50000');
        });

        it('should return null when oracle data is not provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPrice("BTC/USD"); };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return snapshot age', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getSnapshotAge(); };',
                { oracleData: { getPrice: () => null, getSnapshotAge: () => 120, getPriceAtRound: () => null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 120);
        });

        it('should return MAX_SAFE_INTEGER for snapshot age when no oracle', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getSnapshotAge(); };');
            assert.strictEqual(JSON.parse(result.returnValue), Number.MAX_SAFE_INTEGER);
        });

        it('should return price at round', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPriceAtRound("BTC/USD", 5); };',
                { oracleData: { getPrice: () => null, getSnapshotAge: () => 0, getPriceAtRound: (pair, round) => pair === 'BTC/USD' && round === 5 ? '49000' : null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '49000');
        });
    });

    describe('crossChain', function() {
        it('should return attestation', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("BTC", 42); };',
                { crossChainData: { getAttestation: (chain, idx) => chain === 'BTC' && idx === 42 ? { status: 'confirmed' } : null, isSettled: () => false } }
            );
            const val = JSON.parse(result.returnValue);
            assert.strictEqual(val.status, 'confirmed');
        });

        it('should return null for missing attestation', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("DOGE", 1); };',
                { crossChainData: { getAttestation: () => null, isSettled: () => false } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return null when no crossChainData provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("BTC", 1); };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return isSettled boolean', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.isSettled("BTC", 42); };',
                { crossChainData: { getAttestation: () => null, isSettled: (chain, idx) => chain === 'BTC' && idx === 42 } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should return false for isSettled when no crossChainData', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.isSettled("BTC", 1); };');
            assert.strictEqual(JSON.parse(result.returnValue), false);
        });
    });

    describe('logging (extended)', function() {
        it('should stringify object args in log', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.log({ a: 1 });
            };`);
            assert.strictEqual(result.logs[0], '[object Object]');
        });

        it('should report isLogFull correctly', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                for (var i = 0; i < 100; i++) xchain.log('msg');
                return xchain.isLogFull();
            };`);
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should report getLogCount correctly', async function() {
            const result = await execute(vm, `module.exports = function(xchain) {
                xchain.log('a');
                xchain.log('b');
                xchain.log('c');
                return xchain.getLogCount();
            };`);
            assert.strictEqual(JSON.parse(result.returnValue), 3);
        });
    });

    describe('compilation cache', function() {
        it('should use cache within a block', async function() {
            const code = 'module.exports = function(xchain) { return "cached"; };';
            vm.beginBlock();
            const r1 = await execute(vm, code, { contractIndex: 1 });
            const r2 = await execute(vm, code, { contractIndex: 1 });
            vm.endBlock();
            assert.strictEqual(r1.success, true);
            assert.strictEqual(r2.success, true);
            assert.strictEqual(JSON.parse(r1.returnValue), 'cached');
            assert.strictEqual(JSON.parse(r2.returnValue), 'cached');
        });

        it('should clear cache between blocks', async function() {
            const code = 'module.exports = function(xchain) { return "ok"; };';
            vm.beginBlock();
            await execute(vm, code, { contractIndex: 1 });
            vm.endBlock();
            // After endBlock, cache is null — next execute should still work
            const result = await execute(vm, code);
            assert.strictEqual(result.success, true);
        });
    });

    describe('default config', function() {
        it('should use default gasCeiling if not provided', function() {
            const vm2 = new XChainVM({ gasSchedule: GAS_SCHEDULE });
            assert.strictEqual(vm2.gasCeiling, 1000000);
        });

        it('should use default limits if not provided', function() {
            const vm2 = new XChainVM({ gasSchedule: GAS_SCHEDULE });
            assert.strictEqual(vm2.limits.maxCpuTimeMs, 30000);
            assert.strictEqual(vm2.limits.maxMemory, 8);
            assert.strictEqual(vm2.limits.maxEmissions, 50);
        });
    });

    describe('validateSyntax', function() {
        it('should accept valid code', function() {
            assert.strictEqual(vm.validateSyntax('var x = 1;').valid, true);
        });

        it('should reject invalid code', function() {
            const result = vm.validateSyntax('function { bad }');
            assert.strictEqual(result.valid, false);
            assert(result.error.includes('syntax error'));
        });
    });

    describe('checkFloatWarnings', function() {
        it('should return warnings for float literals', function() {
            const warnings = vm.checkFloatWarnings('var x = 3.14;');
            assert.strictEqual(warnings.length, 1);
            assert(warnings[0].includes('3.14'));
        });

        it('should return empty array for integer-only code', function() {
            const warnings = vm.checkFloatWarnings('var x = 42;');
            assert.strictEqual(warnings.length, 0);
        });
    });

    describe('emit all 16 action types (integration)', function() {
        const emitTests = [
            { method: 'send', params: "{ destination: 'a', tick: 'T', quantity: '1' }", action: 'SEND' },
            { method: 'destroy', params: "{ tick: 'T', quantity: '1' }", action: 'DESTROY' },
            { method: 'issue', params: "{ tick: 'NEW' }", action: 'ISSUE' },
            { method: 'mint', params: "{ tick: 'T', quantity: '1' }", action: 'MINT' },
            { method: 'order', params: "{ giveAmount: '10', getAmount: '5' }", action: 'ORDER' },
            { method: 'dispenser', params: "{ tick: 'T' }", action: 'DISPENSER' },
            { method: 'dividend', params: "{ tick: 'T', dividendTick: 'D', quantity: '1' }", action: 'DIVIDEND' },
            { method: 'airdrop', params: "{ tick: 'T', quantity: '1', listActionIndex: 1 }", action: 'AIRDROP' },
            { method: 'callback', params: "{ tick: 'T' }", action: 'CALLBACK' },
            { method: 'file', params: "{ data: 'x' }", action: 'FILE' },
            { method: 'list', params: "{ items: [] }", action: 'LIST' },
            { method: 'coinpay', params: "{ orderMatchActionIndex: 1 }", action: 'COINPAY' },
            { method: 'sweep', params: "{ destination: 'a' }", action: 'SWEEP' },
            { method: 'link', params: "{ coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }", action: 'LINK' },
            { method: 'broadcast', params: "{ data: 'x' }", action: 'BROADCAST' },
            { method: 'message', params: "{ destination: 'a', body: 'hi' }", action: 'MESSAGE' }
        ];

        for (const { method, params, action } of emitTests) {
            it('should emit ' + action + ' via xchain.emit.' + method, async function() {
                const code = `module.exports = function(xchain) { xchain.emit.${method}(${params}); };`;
                const result = await execute(vm, code);
                assert.strictEqual(result.success, true, 'emit.' + method + ' failed: ' + result.error);
                assert.strictEqual(result.emittedActions.length, 1);
                assert.strictEqual(result.emittedActions[0].action, action);
            });
        }
    });
});
