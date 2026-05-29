const assert = require('assert');
const fs = require('fs');
const path = require('path');

// These tests require isolated-vm. Skip if not available.
let XChainVM;
try {
    XChainVM = require('../../src/index.js');
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

    // The transcendentals (pow/log/log2/log10/sqrt) are stripped from the
    // sandbox Math because IEEE 754 does not mandate correctly-rounded results
    // for them (sqrt is correctly-rounded by the spec but is removed alongside
    // the others for a single, consistent surface). The host libm can differ by
    // 1 ULP across CPU architectures, which would diverge state hashes across a
    // heterogeneous validator fleet. Contracts must use the deterministic
    // bignumber equivalents at xchain.math.{pow,log,log2,log10,sqrt}. These
    // tests assert the strip at the live-isolate layer, independent of the
    // deploy-time syntax validator.
    ['pow', 'log', 'log2', 'log10', 'sqrt'].forEach(function(name) {
        it('should strip non-deterministic Math.' + name, async function() {
            const result = await executeCode(vm,
                'module.exports = function(xchain) { return typeof Math.' + name + '; };');
            assert.strictEqual(result.success, true);
            assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
        });
    });

    it('should make Math.pow(2.1, 1.5) uncallable inside the sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    return 'called:' + Math.pow(2.1, 1.5);
                } catch(e) {
                    return 'threw';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        // Math.pow is undefined, so calling it throws a TypeError inside the contract.
        assert.strictEqual(JSON.parse(result.returnValue), 'threw');
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
        const code = fs.readFileSync(path.join(__dirname, '../contracts/sandbox_escape.js'), 'utf8');
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

    it('should block WeakRef', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof WeakRef; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block FinalizationRegistry', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof FinalizationRegistry; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Proxy', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Proxy; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block SharedArrayBuffer', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof SharedArrayBuffer; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block Atomics', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Atomics; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block queueMicrotask', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof queueMicrotask; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block setInterval', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setInterval; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block setImmediate', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof setImmediate; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should block console', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof console; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('should keep Math.ceil', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.ceil(3.2); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 4);
    });

    it('should keep Math.abs', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return Math.abs(-7); };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 7);
    });

    it('should keep Math.PI', async function() {
        const result = await executeCode(vm,
            'module.exports = function(xchain) { return typeof Math.PI; };');
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'number');
    });

    it('should freeze Math object (no mutation)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Math.custom = function() {};
                } catch(e) {
                    return 'frozen';
                }
                return typeof Math.custom;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'frozen' || val === 'undefined', 'Math should be frozen: ' + val);
    });

    it('should block indirect eval', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var indirectEval = (0, eval);
                    return typeof indirectEval;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'), 'indirect eval should be blocked: ' + val);
    });

    it('should block Function constructor', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = Function('return 1');
                    return fn();
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('should freeze the xchain object', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.custom = 'injected';
                } catch(e) {
                    return 'frozen';
                }
                return typeof xchain.custom;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'frozen' || val === 'undefined', 'xchain should be frozen: ' + val);
    });
});
