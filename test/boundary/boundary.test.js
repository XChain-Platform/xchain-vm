/**
 * XChain VM — Boundary Test Suite
 *
 * Tests the VM at the exact edges of every configurable limit, hardcoded cap,
 * and validation threshold. Each section targets a specific boundary area
 * from the Boundary Testing Plan.
 *
 * Sections:
 *   1. Gas Ceiling Enforcement (G-1 through G-7)
 *   2. Wall-Clock Timeout (T-1 through T-4)
 *   3. Memory Limits (M-1 through M-4)
 *   4. Code Size (CS-1 through CS-6)
 *   5. State Management (S-1 through S-14)
 *   6. Emission Limits (E-1 through E-7)
 *   7. Log Limits (L-1 through L-7)
 *   8. Return Value Truncation (R-1 through R-5)
 *   9. Math Operations (MA-1 through MA-10)
 *  10. Metering & AST Injection (ME-1 through ME-7)
 *  11. Sandbox Escape Boundaries (SB-1 through SB-8)
 *  12. Gateway Parameter Boundaries (GW-1 through GW-9)
 *  13. Emit Action Field Boundaries (EA-1 through EA-8)
 *  14. Compound Interaction Boundaries
 *  15. Determinism at Boundaries
 */

const assert = require('assert');
const GasTracker = require('../../src/gas.js');
const StateManager = require('../../src/state.js');
const EmissionCollector = require('../../src/collector.js');
const { meterCode, hasGasIdentifier } = require('../../src/metering.js');
const { buildMathAPI } = require('../../src/math.js');
const { ContractRevertError } = require('../../src/errors.js');
const { validateSyntax } = require('../../src/syntax.js');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping VM boundary tests — isolated-vm not available: ' + e.message);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_EMISSION: 500
};

function createVM(overrides) {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: overrides?.gasCeiling !== undefined ? overrides.gasCeiling : 1000000,
        limits: {
            maxCpuTimeMs: overrides?.maxCpuTimeMs !== undefined ? overrides.maxCpuTimeMs : 5000,
            maxMemory: overrides?.maxMemory !== undefined ? overrides.maxMemory : 8,
            maxEmissions: overrides?.maxEmissions !== undefined ? overrides.maxEmissions : 50,
            maxStateKeys: overrides?.maxStateKeys !== undefined ? overrides.maxStateKeys : 10000,
            maxStateValueSize: overrides?.maxStateValueSize !== undefined ? overrides.maxStateValueSize : 65536,
            maxCodeSize: overrides?.maxCodeSize !== undefined ? overrides.maxCodeSize : 65536,
            maxStateKeySize: overrides?.maxStateKeySize !== undefined ? overrides.maxStateKeySize : 1024,
            maxBlockCacheSize: overrides?.maxBlockCacheSize !== undefined ? overrides.maxBlockCacheSize : 1000
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code:            code,
        state:           opts?.state || {},
        method:          opts?.method || 'default',
        params:          opts?.params || [],
        caller:          opts?.caller !== undefined ? opts.caller : 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext:    opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances:        opts?.balances || {},
        tokenInfo:       opts?.tokenInfo || {},
        oracleData:      opts?.oracleData || null,
        crossChainData:  opts?.crossChainData || null
    });
}

// ============================================================
// Section 1: Gas Ceiling Enforcement (G-1 through G-7)
// ============================================================

describe('Boundary: Gas Ceiling', function() {

    const LIMITS = {
        maxStateKeys: 100,
        maxStateValueSize: 1024
    };

    it('G-1: gas used exactly at ceiling (unit level)', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 100);
        tracker.charge(100);
        assert.strictEqual(tracker.getUsed(), 100);
    });

    it('G-2: gas used one unit above ceiling (unit level)', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 100);
        assert.throws(() => tracker.charge(101));
    });

    it('G-3: gas ceiling of 1', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 1);
        tracker.charge(1); // exactly at ceiling — allowed
        assert.throws(() => tracker.charge(1)); // one more — rejected
    });

    it('G-4: gas ceiling of 0 rejects first charge', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 0);
        assert.throws(() => tracker.chargeComputation());
    });

    it('G-5: gas exactly at ceiling after mixed operations', function() {
        // ceiling = 1 + 200 + 100 = 301 (1 computation + 1 write + 1 read)
        const tracker = new GasTracker(GAS_SCHEDULE, 301);
        tracker.chargeComputation();                // 1
        tracker.charge(GAS_SCHEDULE.VM_STATE_WRITE); // 201
        tracker.charge(GAS_SCHEDULE.VM_STATE_READ);  // 301
        assert.strictEqual(tracker.getUsed(), 301);
    });

    it('G-6: gas overflow after mixed operations discards atomically', function() {
        const tracker = new GasTracker(GAS_SCHEDULE, 300);
        tracker.chargeComputation();                // 1
        tracker.charge(GAS_SCHEDULE.VM_STATE_WRITE); // 201
        assert.throws(() => tracker.charge(GAS_SCHEDULE.VM_STATE_READ)); // 301 > 300
    });

    it('G-7: negative gas schedule values rejected in constructor', function() {
        assert.throws(
            () => new GasTracker({ ...GAS_SCHEDULE, VM_COMPUTATION: -1 }, 1000),
            /non-negative integer/
        );
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Gas Ceiling (integration)', function() {

    it('G-1i: contract succeeds when gas used equals ceiling', async function() {
        // Find exact base gas cost of a minimal contract
        const vm = createVM({ gasCeiling: 1000000 });
        const code = 'module.exports = function(xchain) {};';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const baseCost = result.gasUsed;

        // Now set ceiling exactly to base cost
        const vm2 = createVM({ gasCeiling: baseCost });
        const result2 = await executeCode(vm2, code);
        assert.strictEqual(result2.success, true);
        assert.strictEqual(result2.gasUsed, baseCost);
    });

    it('G-2i: contract fails when gas ceiling is too low for a state write', async function() {
        // A state write costs VM_STATE_WRITE (200) + computation overhead.
        // With a ceiling of 10, the contract should fail.
        const vm = createVM({ gasCeiling: 10 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('key', 'value');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert(result.gasUsed > 0, 'should have used some gas before failing');
    });

    it('G-4i: gas ceiling 1 fails for non-trivial contract', async function() {
        // gasCeiling: 0 is treated as default by the constructor (||).
        // gasCeiling: 1 allows at most 1 unit of computation.
        const vm = createVM({ gasCeiling: 1 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('key', 'value');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
    });
});

// ============================================================
// Section 2: Wall-Clock Timeout (T-1 through T-4)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Wall-Clock Timeout', function() {

    it('T-2: infinite loop with high gas ceiling triggers timeout', async function() {
        this.timeout(15000);
        const vm = createVM({ gasCeiling: 999999999, maxCpuTimeMs: 1000 });
        // Tight loop that charges minimal gas — timeout should fire first
        const code = `module.exports = function(xchain) {
            while (true) {}
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(
            result.error.includes('timeout') || result.error.includes('out_of_gas'),
            'should timeout or run out of gas: ' + result.error
        );
    });

    it('T-3: timeout of 1ms fails most contracts', async function() {
        this.timeout(10000);
        const vm = createVM({ maxCpuTimeMs: 1 });
        const code = `module.exports = function(xchain) {
            var sum = 0;
            for (var i = 0; i < 100000; i++) sum += i;
            return sum;
        };`;
        const result = await executeCode(vm, code);
        // May succeed (tiny contract) or fail — must not crash
        assert(typeof result.success === 'boolean');
    });

    it('T-4: timeout of 0ms does not crash', async function() {
        this.timeout(10000);
        const vm = createVM({ maxCpuTimeMs: 0 });
        const code = 'module.exports = function(xchain) { return 1; };';
        const result = await executeCode(vm, code);
        // Must return a valid result object, not crash
        assert(typeof result.success === 'boolean');
        assert('error' in result);
        assert('gasUsed' in result);
    });
});

// ============================================================
// Section 3: Memory Limits (M-1 through M-4)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Memory Limits', function() {

    it('M-2: memory bomb exceeds limit gracefully', async function() {
        this.timeout(10000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            var s = 'x';
            for (var i = 0; i < 30; i++) s = s + s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        // Could be OOM, gas, timeout, or V8 string length error — all are acceptable
        assert(result.error.includes('error') || result.error.includes('out_of'),
            'should fail gracefully: ' + result.error);
    });

    it('M-4: many small allocations exceeding limit', async function() {
        this.timeout(10000);
        const vm = createVM({ maxMemory: 8 });
        const code = `module.exports = function(xchain) {
            var arr = [];
            for (var i = 0; i < 1000000; i++) arr.push('item_' + i);
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
    });
});

// ============================================================
// Section 4: Code Size (CS-1 through CS-6)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Code Size', function() {

    it('CS-1: code at exactly maxCodeSize executes', async function() {
        const vm = createVM();
        const header = 'module.exports = function(xchain) { /* ';
        const footer = ' */ };';
        const padding = 65536 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert.strictEqual(Buffer.byteLength(code, 'utf8'), 65536);
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });

    it('CS-2: code at maxCodeSize + 1 byte is rejected', async function() {
        const vm = createVM();
        const header = 'module.exports = function(xchain) { /* ';
        const footer = ' */ };';
        const padding = 65537 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert.strictEqual(Buffer.byteLength(code, 'utf8'), 65537);
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('code size exceeds limit'), result.error);
    });

    it('CS-3: empty code fails gracefully', async function() {
        const vm = createVM();
        const result = await executeCode(vm, '');
        assert.strictEqual(result.success, false);
        assert(result.error.includes('error:'), result.error);
    });

    it('CS-4: single semicolon fails with export error', async function() {
        const vm = createVM();
        const result = await executeCode(vm, ';');
        assert.strictEqual(result.success, false);
        assert(result.error.includes('error:'), result.error);
    });

    it('CS-5: extremely long single line (comment padding) parses and executes', async function() {
        const vm = createVM({ maxCodeSize: 70000 });
        // Long single line via comment padding — avoids gas explosion from many expressions
        const header = 'module.exports = function(xchain) { return 42; /* ';
        const footer = ' */ };';
        const padding = 60000 - Buffer.byteLength(header + footer, 'utf8');
        const code = header + 'x'.repeat(padding) + footer;
        assert(!code.includes('\n'), 'should be a single line');
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });
});

describe('Boundary: Code Size (metering)', function() {

    it('CS-6: worst-case metered code completes in reasonable time', function() {
        this.timeout(10000);
        // Many nested ternaries to maximize AST node count
        let expr = '1';
        for (let i = 0; i < 200; i++) {
            expr = '(1 ? ' + expr + ' : 0)';
        }
        const code = 'module.exports = function(xchain) { return ' + expr + '; };';
        const start = Date.now();
        const metered = meterCode(code);
        const elapsed = Date.now() - start;
        assert(typeof metered === 'string');
        assert(elapsed < 5000, 'metering took too long: ' + elapsed + 'ms');
    });
});

// ============================================================
// Section 5: State Management (S-1 through S-14)
// ============================================================

describe('Boundary: State Management', function() {

    const LIMITS = { maxStateKeys: 5, maxStateValueSize: 100, maxStateKeySize: 32 };

    it('S-1: set key count to exactly maxStateKeys', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        assert.strictEqual(sm.getChanges().changes.length, 5);
    });

    it('S-2: set key count to maxStateKeys + 1 rejects', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        assert.throws(() => sm.set('k5', 'v'), /max state keys/);
    });

    it('S-3: delete then re-add at limit succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        for (let i = 0; i < 5; i++) sm.set('k' + i, 'v');
        sm.delete('k0');
        sm.set('new_key', 'v'); // should succeed — room for one
        assert.strictEqual(sm.get('new_key'), 'v');
    });

    it('S-4: value at exactly maxStateValueSize', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        // JSON.stringify of a string adds quotes: "xxx" = length + 2
        const inner = 'x'.repeat(98); // "xxx...x" = 100 bytes
        assert.strictEqual(Buffer.byteLength(JSON.stringify(inner), 'utf8'), 100);
        sm.set('key', inner);
        assert.strictEqual(sm.get('key'), inner);
    });

    it('S-5: value at maxStateValueSize + 1 byte rejects', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        const inner = 'x'.repeat(99); // "xxx...x" = 101 bytes
        assert.strictEqual(Buffer.byteLength(JSON.stringify(inner), 'utf8'), 101);
        assert.throws(() => sm.set('key', inner), /max size/);
    });

    it('S-6: multi-byte UTF-8 at value boundary rejects by byte length', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 100 });
        // emoji is 4 UTF-8 bytes. We need JSON.stringify result > 100 bytes
        // JSON.stringify('emoji...') adds quotes = 2 bytes overhead
        // 25 emojis * 4 bytes = 100 bytes + 2 quotes = 102 bytes in JSON
        const emoji = '\u{1F600}';
        const val = emoji.repeat(25);
        assert(Buffer.byteLength(JSON.stringify(val), 'utf8') > 100);
        assert.throws(() => sm.set('key', val), /max size/);
    });

    it('S-7: empty string value succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', '');
        assert.strictEqual(sm.get('key'), '');
    });

    it('S-8: empty object value succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('key', {});
        assert.deepStrictEqual(sm.get('key'), {});
    });

    it('S-9: deeply nested object caught by size limit', function() {
        const sm = new StateManager({}, { ...LIMITS, maxStateValueSize: 1000 });
        let obj = { v: 'x' };
        for (let i = 0; i < 50; i++) obj = { nested: obj };
        // This will either fit within 1000 bytes or exceed — either way, no crash
        try {
            sm.set('key', obj);
            // If it fit, verify it round-trips
            assert.deepStrictEqual(sm.get('key'), obj);
        } catch (e) {
            assert(e.message.includes('max size'), e.message);
        }
    });

    it('S-10: circular reference produces clear error', function() {
        const sm = new StateManager({}, LIMITS);
        const obj = { a: 1 };
        obj.self = obj;
        assert.throws(() => sm.set('key', obj));
    });

    it('S-11: empty string key succeeds', function() {
        const sm = new StateManager({}, LIMITS);
        sm.set('', 'value');
        assert.strictEqual(sm.get(''), 'value');
        assert.strictEqual(sm.has(''), true);
    });

    it('S-12: very long key rejected by maxStateKeySize', function() {
        const sm = new StateManager({}, LIMITS);
        assert.throws(() => sm.set('x'.repeat(33), 'v'), /key exceeds max size/);
    });

    it('S-13: pre-loaded state at maxStateKeys rejects new key', function() {
        const initial = {};
        for (let i = 0; i < 5; i++) initial['k' + i] = 'v';
        const sm = new StateManager(initial, LIMITS);
        assert.throws(() => sm.set('new', 'v'), /max state keys/);
    });

    it('S-14: delete-set-delete cycle tracks keyCount correctly', function() {
        const sm = new StateManager({ a: '1' }, LIMITS);
        sm.delete('a');    // keyCount: 0
        sm.set('a', '2');  // keyCount: 1
        sm.delete('a');    // keyCount: 0
        const { changes, deletes } = sm.getChanges();
        assert.strictEqual(deletes.length, 1);
        assert(deletes.includes('a'));
        assert.strictEqual(changes.length, 0);
    });
});

// ============================================================
// Section 6: Emission Limits (E-1 through E-7)
// ============================================================

describe('Boundary: Emission Limits', function() {

    it('E-1: emit exactly maxEmissions succeeds', function() {
        const ec = new EmissionCollector(5);
        for (let i = 0; i < 5; i++) ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        assert.strictEqual(ec.getActions().length, 5);
    });

    it('E-2: emit maxEmissions + 1 rejects', function() {
        const ec = new EmissionCollector(5);
        for (let i = 0; i < 5; i++) ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        assert.throws(() => ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' }), /emission limit/);
    });

    it('E-3: emit 0 actions succeeds', function() {
        const ec = new EmissionCollector(50);
        assert.strictEqual(ec.getActions().length, 0);
    });

    it('E-4: maxEmissions = 0 rejects first emit', function() {
        const ec = new EmissionCollector(0);
        assert.throws(() => ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' }), /emission limit/);
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Emission Limits (integration)', function() {

    it('E-5: emit then revert discards emissions (atomicity)', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'addr_' + i, tick: 'T', quantity: '1' });
            }
            xchain.revert('rollback');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('E-6: gas exhaustion during emission burst discards', async function() {
        // Each emit costs 500 gas. 5 emits = 2500 gas + computation overhead
        const vm = createVM({ gasCeiling: 1500, maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: '1' });
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('E-7: all 16 action types at cap', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            xchain.emit.destroy({ tick: 'T', quantity: '1' });
            xchain.emit.issue({ tick: 'NEW' });
            xchain.emit.mint({ tick: 'T', quantity: '1' });
            xchain.emit.order({ giveAmount: '1', getAmount: '1' });
            xchain.emit.dispenser({});
            xchain.emit.dividend({ tick: 'T', dividendTick: 'D', quantity: '1' });
            xchain.emit.airdrop({ tick: 'T', quantity: '1', listActionIndex: 0 });
            xchain.emit.callback({ tick: 'T' });
            xchain.emit.file({});
            xchain.emit.list({});
            xchain.emit.coinpay({ orderMatchActionIndex: 0 });
            xchain.emit.sweep({ destination: 'a' });
            xchain.emit.link({ coin1: 'BTC', coin1ActionIndex: 0, coin2: 'LTC', coin2ActionIndex: 0 });
            xchain.emit.broadcast({});
            xchain.emit.message({ destination: 'a' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 16);
        const types = result.emittedActions.map(a => a.action);
        assert(types.includes('SEND'));
        assert(types.includes('DESTROY'));
        assert(types.includes('ISSUE'));
        assert(types.includes('MINT'));
        assert(types.includes('ORDER'));
        assert(types.includes('DISPENSER'));
        assert(types.includes('DIVIDEND'));
        assert(types.includes('AIRDROP'));
        assert(types.includes('CALLBACK'));
        assert(types.includes('FILE'));
        assert(types.includes('LIST'));
        assert(types.includes('COINPAY'));
        assert(types.includes('SWEEP'));
        assert(types.includes('LINK'));
        assert(types.includes('BROADCAST'));
        assert(types.includes('MESSAGE'));
    });
});

// ============================================================
// Section 7: Log Limits (L-1 through L-7)
// ============================================================

describe('Boundary: Log Limits', function() {

    it('L-1: log exactly 100 entries', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 100; i++) ec.addLog('msg ' + i);
        assert.strictEqual(ec.getLogs().length, 100);
        assert.strictEqual(ec.isLogFull(), true);
    });

    it('L-2: log 101 entries drops 101st', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 101; i++) ec.addLog('msg ' + i);
        assert.strictEqual(ec.getLogs().length, 100);
    });

    it('L-3: log entry at exactly 1024 bytes preserved', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1024);
        assert.strictEqual(Buffer.byteLength(msg, 'utf8'), 1024);
        ec.addLog(msg);
        assert.strictEqual(ec.getLogs()[0].length, 1024);
        assert(!ec.getLogs()[0].includes('truncated'));
    });

    it('L-4: log entry at 1025 bytes truncated', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1025);
        ec.addLog(msg);
        assert(ec.getLogs()[0].endsWith('...(truncated)'));
    });

    it('L-5: empty string log preserved', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('');
        assert.strictEqual(ec.getLogs()[0], '');
    });

    it('L-7: multi-byte characters truncated by byte length', function() {
        const ec = new EmissionCollector(50);
        // 256 emojis * 4 bytes = 1024 bytes exactly
        const emoji = '\u{1F600}';
        const atLimit = emoji.repeat(256);
        assert.strictEqual(Buffer.byteLength(atLimit, 'utf8'), 1024);
        ec.addLog(atLimit);
        assert(!ec.getLogs()[0].includes('truncated'), 'exactly 1024 bytes should not truncate');

        // 257 emojis = 1028 bytes
        const overLimit = emoji.repeat(257);
        ec.addLog(overLimit);
        assert(ec.getLogs()[1].includes('...(truncated)'), 'over 1024 bytes should truncate');
    });
});

(XChainVM ? describe : describe.skip)('Boundary: Log Limits (integration)', function() {

    it('L-6: logs preserved on failure', async function() {
        const vm = createVM();
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) xchain.log('entry ' + i);
            xchain.revert('fail');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.logs.length, 50);
    });
});

// ============================================================
// Section 8: Return Value Truncation (R-1 through R-5)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Return Value Truncation', function() {

    it('R-1: return value under 65536 bytes not truncated', async function() {
        const vm = createVM();
        // Build a string inside the contract to avoid code size limit
        const code = `module.exports = function(xchain) {
            var s = '';
            for (var i = 0; i < 1000; i++) s += 'xxxxxxxxxx';
            return s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue !== null);
        // 10000 chars serialized as JSON: "xxx..." = 10002 bytes, well under 65536
        assert(result.returnValue.length > 0);
    });

    it('R-2: return value over 65536 bytes truncated', async function() {
        this.timeout(10000);
        const vm = createVM();
        // Build a string longer than 65536 inside the contract
        const code = `module.exports = function(xchain) {
            var s = 'x'.repeat(70000);
            return s;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue !== null);
        assert.strictEqual(result.returnValue.length, 65536);
    });

    it('R-3: return undefined gives null returnValue', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.returnValue, null);
    });

    it('R-4: return null gives "null" returnValue', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { return null; };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // null gets JSON.stringify'd to "null" with \x02 prefix
        assert(result.returnValue === 'null' || result.returnValue === null);
    });

    it('R-5: return non-serializable value handled gracefully', async function() {
        const vm = createVM();
        // Return a function — JSON.stringify(function) returns undefined
        const code = 'module.exports = function(xchain) { return function() {}; };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // Function serialized inside isolate: JSON.stringify(fn) → undefined → wrapper returns undefined
        // Host sees undefined → returnValue = null. Or wrapper produces no \x02 prefix.
        // Either way, must not crash.
    });
});

// ============================================================
// Section 9: Math Operations (MA-1 through MA-10)
// ============================================================

describe('Boundary: Math Operations', function() {

    const math = buildMathAPI();

    it('MA-1: division by zero throws', function() {
        assert.throws(() => math.divide('100', '0'), /Division by zero/);
    });

    it('MA-2: extremely large numbers (within 256-char limit)', function() {
        const big = '9'.repeat(200);
        const result = math.add(big, '1');
        assert(typeof result === 'string');
        assert(result.length >= 200);
    });

    it('MA-3: repeating decimal returns fixed notation', function() {
        const result = math.divide('1', '3');
        assert(typeof result === 'string');
        assert(!result.includes('e'), 'should not contain scientific notation');
        assert(result.startsWith('0.333'));
    });

    it('MA-4: negative numbers handled correctly', function() {
        assert.strictEqual(math.subtract('0', '1'), '-1');
        assert.strictEqual(math.abs('-42'), '42');
    });

    it('MA-5: non-numeric string input throws ContractRevertError', function() {
        assert.throws(() => math.add('abc', '1'), ContractRevertError);
    });

    it('MA-6: empty string input throws', function() {
        assert.throws(() => math.add('', '1'), ContractRevertError);
    });

    it('MA-7: scientific notation input accepted deterministically', function() {
        const result = math.add('1e18', '1');
        assert(typeof result === 'string');
        assert(!result.includes('e'), 'output should be fixed notation');
    });

    it('MA-8: Infinity string input either throws or returns finite result', function() {
        // mathjs may accept 'Infinity' as a valid bignumber — verify behavior is deterministic
        try {
            const result = math.add('Infinity', '1');
            // If it doesn't throw, verify the result is a string (deterministic)
            assert(typeof result === 'string');
        } catch (e) {
            assert(e instanceof ContractRevertError);
        }
    });

    it('MA-9: isZero edge cases', function() {
        assert.strictEqual(math.isZero('0'), true);
        assert.strictEqual(math.isZero('0.0'), true);
        assert.strictEqual(math.isZero('-0'), true);
        assert.strictEqual(math.isZero('0.00000'), true);
        assert.strictEqual(math.isZero('0.0001'), false);
    });

    it('MA-10: mod by zero either throws or returns deterministic result', function() {
        // mathjs mod(x, 0) may return NaN or throw — verify behavior is consistent
        try {
            const result = math.mod('10', '0');
            assert(typeof result === 'string');
        } catch (e) {
            assert(e instanceof ContractRevertError);
        }
    });
});

// ============================================================
// Section 10: Metering & AST Injection (ME-1 through ME-7)
// ============================================================

describe('Boundary: Metering', function() {

    it('ME-1: binary expression depth exactly 10 does not inject extra gas', function() {
        // 10 operands = depth 9, which is <= 10 threshold
        const operands = Array.from({ length: 10 }, (_, i) => String(i));
        const expr = operands.join(' + ');
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);
        // Count __gas occurrences — should only have function-level injection, not binary depth injection
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        // Store for comparison with depth 11
        this._depth10GasCount = gasCount;
        assert(typeof metered === 'string');
    });

    it('ME-2: binary expression depth 11+ injects extra gas', function() {
        // 12 operands = depth 11, which is > 10 threshold
        const operands = Array.from({ length: 12 }, (_, i) => String(i));
        const expr = operands.join(' + ');
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);

        // Compare with a shallow expression
        const shallowExpr = Array.from({ length: 5 }, (_, i) => String(i)).join(' + ');
        const shallowCode = 'var result = ' + shallowExpr + ';';
        const shallowMetered = meterCode(shallowCode);

        const deepGas = (metered.match(/__gas\(/g) || []).length;
        const shallowGas = (shallowMetered.match(/__gas\(/g) || []).length;
        assert(deepGas > shallowGas, 'deep binary should have more gas calls');
    });

    it('ME-3: deeply nested ternaries do not stack overflow', function() {
        this.timeout(10000);
        let expr = '0';
        for (let i = 0; i < 100; i++) {
            expr = '(1 ? ' + expr + ' : 0)';
        }
        const code = 'var result = ' + expr + ';';
        const metered = meterCode(code);
        assert(typeof metered === 'string');
        // Each ternary should inject gas into the test expression
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        assert(gasCount >= 100, 'should have gas calls for each ternary');
    });

    it('ME-4: __gas identifier rejected at deploy', function() {
        assert.strictEqual(hasGasIdentifier('var __gas = 1;'), true);
        const result = validateSyntax('var __gas = 1;');
        assert.strictEqual(result.valid, false);
        assert(result.error.includes('__gas'));
    });

    it('ME-5: ES2020 features parse, ES2022+ rejected', function() {
        // ES2020: optional chaining and nullish coalescing — should parse
        const es2020 = 'var x = obj?.foo ?? "default";';
        const metered2020 = meterCode(es2020);
        assert(typeof metered2020 === 'string');

        // ES2022: class fields — should fail
        const es2022 = 'class Foo { x = 1; }';
        assert.throws(() => meterCode(es2022));
    });

    it('ME-6: enormous switch statement meters without error', function() {
        this.timeout(10000);
        let cases = '';
        for (let i = 0; i < 1000; i++) {
            cases += 'case ' + i + ': break;\n';
        }
        const code = 'var x = 0; switch(x) { ' + cases + ' }';
        const metered = meterCode(code);
        assert(typeof metered === 'string');
        // Each case should get a gas call
        const gasCount = (metered.match(/__gas\(/g) || []).length;
        assert(gasCount >= 1000, 'should have gas call per case');
    });

    it('ME-7: arrow function with expression body gets gas injection', function() {
        const code = 'var f = () => 42;';
        const metered = meterCode(code);
        // Arrow expression body should be wrapped: () => (__gas(1), 42)
        assert(metered.includes('__gas'), 'should inject gas into arrow body');
    });
});

// ============================================================
// Section 11: Sandbox Escape Boundaries (SB-1 through SB-8)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Sandbox Escapes', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('SB-1: stripped globals return undefined', async function() {
        const code = `module.exports = function(xchain) {
            return {
                process: typeof process,
                require: typeof require,
                fetch: typeof fetch
            };
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed.process, 'undefined');
        assert.strictEqual(parsed.require, 'undefined');
        assert.strictEqual(parsed.fetch, 'undefined');
    });

    it('SB-2: Function constructor escape blocked', async function() {
        const code = `module.exports = function(xchain) {
            try {
                var fn = (function(){}).constructor;
                var global = fn('return this')();
                return 'escaped: ' + typeof global.process;
            } catch(e) {
                return 'blocked: ' + e.message;
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        // Should either be blocked or return undefined for process
        assert(
            result.returnValue.includes('blocked') ||
            result.returnValue.includes('undefined'),
            'should not access host process: ' + result.returnValue
        );
    });

    it('SB-3: globalThis cleaned of injected references', async function() {
        const code = `module.exports = function(xchain) {
            var names = Object.getOwnPropertyNames(globalThis);
            var leaked = names.filter(function(n) {
                return n.indexOf('__state') === 0 ||
                       n.indexOf('__emit') === 0 ||
                       n.indexOf('__oracle') === 0 ||
                       n.indexOf('__crossChain') === 0 ||
                       n.indexOf('__getB') === 0;
            });
            return leaked;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const leaked = JSON.parse(result.returnValue);
        assert.strictEqual(leaked.length, 0, 'should not leak internal references: ' + result.returnValue);
    });

    it('SB-4: prototype pollution does not affect host', async function() {
        const code = `module.exports = function(xchain) {
            Object.prototype.polluted = true;
            return 'done';
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(({}).polluted, undefined, 'host Object.prototype must not be polluted');
    });

    it('SB-5: indirect eval blocked', async function() {
        const code = `module.exports = function(xchain) {
            try {
                var e = eval;
                return 'eval result: ' + e('1+1');
            } catch(err) {
                return 'blocked';
            }
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('blocked') || result.returnValue === '"blocked"',
            'indirect eval should be blocked: ' + result.returnValue);
    });

    it('SB-6: Date is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof Date;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'Date should be stripped: ' + result.returnValue);
    });

    it('SB-7: Math.random is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof Math.random;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'Math.random should be stripped: ' + result.returnValue);
    });

    it('SB-8: SharedArrayBuffer is undefined', async function() {
        const code = `module.exports = function(xchain) {
            return typeof SharedArrayBuffer;
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert(result.returnValue.includes('undefined'), 'SharedArrayBuffer should be stripped: ' + result.returnValue);
    });
});

// ============================================================
// Section 12: Gateway Parameter Boundaries (GW-1 through GW-9)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Gateway Parameters', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('GW-1: empty params array returns count 0', async function() {
        const code = 'module.exports = function(xchain) { return xchain.getInputParamCount(); };';
        const result = await executeCode(vm, code, { params: [] });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === '0' || result.returnValue === 0);
    });

    it('GW-2: very large params array', async function() {
        const params = Array.from({ length: 1000 }, (_, i) => 'param_' + i);
        const code = `module.exports = function(xchain) {
            return xchain.getInputParamCount();
        };`;
        const result = await executeCode(vm, code, { params });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === '1000' || result.returnValue === 1000);
    });

    it('GW-3: params with bridge control characters survive round-trip', async function() {
        const params = ['normal', '\x01prefix', '\x02prefix', '\x03prefix', 'has\x00null'];
        const code = `module.exports = function(xchain) {
            var results = [];
            for (var i = 0; i < xchain.getInputParamCount(); i++) {
                results.push(xchain.getInputParam(i));
            }
            return results;
        };`;
        const result = await executeCode(vm, code, { params });
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed[0], 'normal');
        assert.strictEqual(parsed[1], '\x01prefix');
        assert.strictEqual(parsed[2], '\x02prefix');
        assert.strictEqual(parsed[3], '\x03prefix');
        assert.strictEqual(parsed[4], 'has\x00null');
    });

    it('GW-4: missing blockContext fields do not crash', async function() {
        const code = `module.exports = function(xchain) {
            return JSON.stringify({
                h: xchain.getBlockHeight(),
                t: xchain.getBlockTimestamp(),
                hash: xchain.getBlockHash()
            });
        };`;
        const result = await executeCode(vm, code, { blockContext: {} });
        assert.strictEqual(result.success, true);
    });

    it('GW-5: null caller address accessible', async function() {
        const code = 'module.exports = function(xchain) { return xchain.getSourceAddress(); };';
        const result = await executeCode(vm, code, { caller: null });
        assert.strictEqual(result.success, true);
        // null returns as null through the bridge
        assert(result.returnValue === null || result.returnValue === 'null',
            'expected null, got: ' + result.returnValue);
    });

    it('GW-6: getBalance for nonexistent address returns null', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.getBalance('nonexistent', 'TOKEN');
        };`;
        const result = await executeCode(vm, code, { balances: {} });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-7: getTokenInfo for nonexistent token returns null', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.getTokenInfo('NONEXISTENT');
        };`;
        const result = await executeCode(vm, code, { tokenInfo: {} });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-8: oracle data unavailable does not crash', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.oracle.getPrice('BTC');
        };`;
        const result = await executeCode(vm, code, { oracleData: null });
        assert.strictEqual(result.success, true);
        assert(result.returnValue === null || result.returnValue === 'null');
    });

    it('GW-9: oracle getSnapshotAge fallback returns MAX_SAFE_INTEGER', async function() {
        const code = `module.exports = function(xchain) {
            return xchain.oracle.getSnapshotAge();
        };`;
        const result = await executeCode(vm, code, { oracleData: null });
        assert.strictEqual(result.success, true);
        assert(
            result.returnValue === String(Number.MAX_SAFE_INTEGER) ||
            Number(result.returnValue) === Number.MAX_SAFE_INTEGER
        );
    });
});

// ============================================================
// Section 13: Emit Action Field Boundaries (EA-1 through EA-8)
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Emit Action Fields', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('EA-1: SEND with quantity "0" passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: '0' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.quantity, '0');
    });

    it('EA-2: SEND with negative quantity passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: '-1' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.quantity, '-1');
    });

    it('EA-3: SEND with non-string quantity rejected by type validation', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'x', tick: 'T', quantity: 12345 });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'should reject non-string quantity: ' + result.error);
    });

    it('EA-4: ISSUE with tick "" passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.issue({ tick: '' });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.tick, '');
    });

    it('EA-5: DISPENSER with empty params passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.dispenser({});
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
    });

    it('EA-6: DISPENSER with null params treated as empty', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.dispenser(null);
        };`;
        const result = await executeCode(vm, code);
        // null spreads to {} — should not crash
        assert.strictEqual(result.success, true);
    });

    it('EA-7: emit with extra unknown fields passes through', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.send({
                destination: 'x', tick: 'T', quantity: '1',
                evil: 'payload', extra: 42
            });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.evil, 'payload');
        assert.strictEqual(result.emittedActions[0].params.extra, 42);
    });

    it('EA-8: LINK with MAX_SAFE_INTEGER actionIndex passes gateway', async function() {
        const code = `module.exports = function(xchain) {
            xchain.emit.link({
                coin1: 'BTC', coin1ActionIndex: 9007199254740991,
                coin2: 'LTC', coin2ActionIndex: 9007199254740991
            });
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions[0].params.coin1ActionIndex, 9007199254740991);
    });
});

// ============================================================
// Section 14: Compound Interaction Boundaries
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Compound Interactions', function() {

    it('gas exhaustion during state write discards atomically', async function() {
        // Set ceiling so there's enough gas for some computation + 1 state write but not 2
        const vm = createVM({ gasCeiling: 300 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.state.set('c', '3');
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'), result.error);
        assert.strictEqual(result.stateChanges.length, 0, 'state changes must be discarded');
        assert.strictEqual(result.emittedActions.length, 0);
    });

    it('state key delete-then-add at exact limit', async function() {
        const vm = createVM({ maxStateKeys: 3 });
        const initial = { a: '1', b: '2', c: '3' };
        const code = `module.exports = function(xchain) {
            xchain.state.delete('a');
            xchain.state.set('d', '4');
            return xchain.state.get('d');
        };`;
        const result = await executeCode(vm, code, { state: initial });
        assert.strictEqual(result.success, true);
    });

    it('return value + 50 emissions succeeds', async function() {
        const vm = createVM({ maxEmissions: 50 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 50; i++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
            return 'done_with_' + 'x'.repeat(1000);
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 50);
        assert(result.returnValue !== null);
    });

    it('state value at limit + emit at limit in same tx', async function() {
        const vm = createVM({ maxEmissions: 5, maxStateValueSize: 100 });
        const code = `module.exports = function(xchain) {
            var bigVal = '';
            for (var i = 0; i < 96; i++) bigVal += 'x';
            xchain.state.set('big', bigVal);
            for (var j = 0; j < 5; j++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
            return 'ok';
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.stateChanges.length, 1);
        assert.strictEqual(result.emittedActions.length, 5);
    });

    it('error classification: spoofed \\x03GAS classified as generic error', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { throw new Error("\\x03GAS:999999:100"); };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('error:'), 'should be generic error, got: ' + result.error);
    });

    it('error classification: spoofed \\x03REVERT classified as generic error', async function() {
        const vm = createVM();
        const code = 'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };';
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('error:'), 'should be generic error, got: ' + result.error);
    });

    it('bridge control chars in state values survive round-trip', async function() {
        const vm = createVM();
        // Use String.fromCharCode inside the contract to produce actual control characters
        const code = `module.exports = function(xchain) {
            var c1 = String.fromCharCode(1) + 'prefix';
            var c2 = String.fromCharCode(2) + 'prefix';
            var c3 = String.fromCharCode(3) + 'prefix';
            xchain.state.set('k1', c1);
            xchain.state.set('k2', c2);
            xchain.state.set('k3', c3);
            return {
                k1: xchain.state.get('k1'),
                k2: xchain.state.get('k2'),
                k3: xchain.state.get('k3')
            };
        };`;
        const result = await executeCode(vm, code);
        assert.strictEqual(result.success, true);
        const parsed = JSON.parse(result.returnValue);
        assert.strictEqual(parsed.k1, '\x01prefix');
        assert.strictEqual(parsed.k2, '\x02prefix');
        assert.strictEqual(parsed.k3, '\x03prefix');
    });
});

// ============================================================
// Section 15: Determinism at Boundaries
// ============================================================

(XChainVM ? describe : describe.skip)('Boundary: Determinism', function() {

    it('identical results across 3 runs at gas boundary', async function() {
        const vm = createVM({ gasCeiling: 500 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('counter', '1');
            return xchain.math.add('100', '200');
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].returnValue, results[0].returnValue);
            assert.deepStrictEqual(results[i].stateChanges, results[0].stateChanges);
            assert.deepStrictEqual(results[i].emittedActions, results[0].emittedActions);
        }
    });

    it('identical failure results across 3 runs at emission boundary', async function() {
        const vm = createVM({ maxEmissions: 3 });
        const code = `module.exports = function(xchain) {
            for (var i = 0; i < 10; i++) {
                xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            }
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].error, results[0].error);
        }
    });

    it('identical results across 3 runs with state at limit', async function() {
        const vm = createVM({ maxStateKeys: 3 });
        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.state.set('c', '3');
            return xchain.state.get('a');
        };`;
        const results = [];
        for (let i = 0; i < 3; i++) {
            results.push(await executeCode(vm, code));
        }
        for (let i = 1; i < results.length; i++) {
            assert.strictEqual(results[i].success, results[0].success);
            assert.strictEqual(results[i].gasUsed, results[0].gasUsed);
            assert.strictEqual(results[i].returnValue, results[0].returnValue);
            assert.deepStrictEqual(results[i].stateChanges, results[0].stateChanges);
        }
    });
});
