const assert = require('assert');
const fs = require('fs');
const path = require('path');

// These tests require isolated-vm. Skip if not available.
let XChainVM;
try {
    XChainVM = require('../src/index.js');
} catch (e) {
    console.log('Skipping sandbox tests — isolated-vm not available: ' + e.message);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
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

function executeCode(vm, code) {
    return vm.execute({
        code: code,
        state: {},
        method: 'default',
        params: [],
        caller: 'test_address',
        contractAddress: 'C:BTC:1',
        blockContext: { height: 100, timestamp: 1700000000, hash: 'abc123' }
    });
}

(XChainVM ? describe : describe.skip)('Sandbox', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should block process access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof process; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block require access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof require; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Date access', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Date; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Math.random', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Math.random; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should keep deterministic Math functions', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.floor(3.7); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 3);
    });

    it('should block setTimeout', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setTimeout; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block eval', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof eval; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block constructor.constructor escape', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = this.constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        // Either returns 'undefined' or 'blocked: ...'
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'), 'should be blocked: ' + val);
    });

    it('should run sandbox_escape.js contract', async function() {
        const code = fs.readFileSync(path.join(__dirname, 'contracts/sandbox_escape.js'), 'utf8');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // All escape attempts should report blocked or undefined
        for (const log of result.logs) {
            assert(log.includes('undefined') || log.includes('blocked'),
                'escape attempt should be blocked: ' + log);
        }
    });

    it('should not affect host process', async function() {
        // Execute a contract that tries to mess with host
        await executeCode(vm, `
            module.exports = function(xchain) {
                try { process.exit(1); } catch(e) {}
                try { require('fs').unlinkSync('/tmp/test'); } catch(e) {}
                return 'done';
            };
        `);
        // If we reach here, host was not affected
        assert(true);
    });
});
