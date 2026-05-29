const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping determinism tests — isolated-vm not available: ' + e.message);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function hashResult(result) {
    // Normalize for comparison: sort state changes by key
    const normalized = {
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed,
        returnValue: result.returnValue,
        stateChanges: [...result.stateChanges].sort((a, b) => a.key.localeCompare(b.key)),
        stateDeletes: [...result.stateDeletes].sort(),
        emittedActions: result.emittedActions,
        logs: result.logs
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function runTwice(vm, opts) {
    const result1 = await vm.execute(opts);
    const result2 = await vm.execute(opts);
    return [result1, result2];
}

(XChainVM ? describe : describe.skip)('Determinism', function() {

    let vm;
    before(function() { vm = createVM(); });

    const baseOpts = {
        state: { counter: '5', owner: 'addr1' },
        method: 'default',
        params: ['arg1', 'arg2'],
        caller: 'addr1',
        contractAddress: 'C:BTC:100',
        blockContext: { height: 500, timestamp: 1700000000, hash: 'blockhash123' }
    };

    it('should produce identical results for state_counter', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/state_counter.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'increment', state: { counter: '5' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical results for simple_send', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/simple_send.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'send', params: ['dest_addr', '100'],
                       state: { owner: 'addr1', token: 'TEST' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical results for amm_swap', async function() {
        const code = fs.readFileSync(path.join(__dirname, '../contracts/amm_swap.js'), 'utf8');
        const opts = { ...baseOpts, code, method: 'swap', params: ['100', 'TOKENA'],
                       state: { tokenA: 'TOKENA', tokenB: 'TOKENB', reserveA: '10000', reserveB: '5000' } };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
    });

    it('should produce identical gas usage', async function() {
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 10; i++) {
                xchain.state.set('key_' + i, String(i));
            }
            return 'done';
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(r1.gasUsed, r2.gasUsed);
    });

    it('should produce identical failure results', async function() {
        const code = `module.exports = function(xchain) {
            xchain.state.set('before', 'revert');
            xchain.revert('test failure');
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, false);
    });

    it('should produce identical results for math operations', async function() {
        const code = `module.exports = function(xchain) {
            var a = xchain.math.divide('1', '3');
            var b = xchain.math.multiply(a, '3');
            var c = xchain.math.subtract(b, '1');
            return { a: a, b: b, c: c };
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.success, true);
    });

    it('should produce identical results for emit operations', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'addr1', tick: 'T', quantity: '100' });
            xchain.emit.send({ destination: 'addr2', tick: 'T', quantity: '200' });
            return 'done';
        };`;
        const opts = { ...baseOpts, code };
        const [r1, r2] = await runTwice(vm, opts);
        assert.strictEqual(hashResult(r1), hashResult(r2));
        assert.strictEqual(r1.emittedActions.length, 2);
    });

    it('should produce identical results across 5 runs', async function() {
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 5; i++) {
                xchain.state.set('k' + i, xchain.math.multiply(String(i), '10'));
            }
            return 'done';
        };`;
        const opts = { ...baseOpts, code, state: {} };
        const hashes = [];
        for (let i = 0; i < 5; i++) {
            const result = await vm.execute(opts);
            hashes.push(hashResult(result));
        }
        const allEqual = hashes.every(h => h === hashes[0]);
        assert(allEqual, 'all 5 runs should produce identical results');
    });
});
