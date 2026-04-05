/*********************************************************************
 * Security Audit Tests
 *
 * Tests for all vulnerabilities identified in the security audit:
 *   - Sandbox escape vectors (RISK-01 through RISK-03)
 *   - Error type spoofing (RISK-04)
 *   - Gas metering bypass (RISK-05, RISK-06)
 *   - Emit parameter injection / prototype pollution (RISK-10, RISK-11)
 *   - Math input abuse (RISK-12)
 *   - Information leakage (RISK-15)
 ********************************************************************/

const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping security tests — isolated-vm not available: ' + e.message);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
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
            maxStateKeySize: overrides?.maxStateKeySize || 1024,
            maxCodeSize: 65536
        }
    });
}

function executeCode(vm, code, opts) {
    return vm.execute({
        code,
        state: opts?.state || {},
        method: opts?.method || 'default',
        params: opts?.params || [],
        caller: opts?.caller || 'test_addr',
        contractAddress: opts?.contractAddress || 'C:BTC:1',
        blockContext: opts?.blockContext || { height: 100, timestamp: 1700000000, hash: 'abc123' },
        balances: opts?.balances || {},
        tokenInfo: opts?.tokenInfo || {}
    });
}

// ===================================================================
// SANDBOX ESCAPE VECTORS (RISK-01, RISK-02, RISK-03)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Sandbox Escape Vectors', function() {

    let vm;
    before(function() { vm = createVM(); });

    // --- RISK-01: Prototype chain traversal ---

    it('RISK-01a: Object.prototype.constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = ({}).constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'Object.prototype.constructor should be undefined, got: ' + val);
    });

    it('RISK-01b: Object.__proto__.constructor traversal should fail', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = ({}).__proto__.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'proto chain escape should be blocked, got: ' + val);
    });

    it('RISK-01c: Array.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = [].constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Array constructor should be neutered, got: ' + val);
    });

    it('RISK-01d: String.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = ''.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'String constructor should be neutered, got: ' + val);
    });

    it('RISK-01e: Number.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = (0).constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Number constructor should be neutered, got: ' + val);
    });

    it('RISK-01f: Boolean.prototype.constructor chain should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = true.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'Boolean constructor should be neutered, got: ' + val);
    });

    // --- RISK-02: Function-type constructor variants ---

    it('RISK-02a: GeneratorFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var gen = (function*(){});
                    var GenCtor = Object.getPrototypeOf(gen).constructor;
                    return typeof GenCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'GeneratorFunction constructor should be neutered, got: ' + val);
    });

    it('RISK-02b: AsyncFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var af = (async function(){});
                    var AFCtor = Object.getPrototypeOf(af).constructor;
                    return typeof AFCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'AsyncFunction constructor should be neutered, got: ' + val);
    });

    it('RISK-02c: AsyncGeneratorFunction constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var agf = (async function*(){});
                    var AGFCtor = Object.getPrototypeOf(agf).constructor;
                    return typeof AGFCtor;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'AsyncGeneratorFunction constructor should be neutered, got: ' + val);
    });

    it('RISK-02d: [].constructor.constructor should not reach Function', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = [].constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'double-constructor escape should be blocked, got: ' + val);
    });

    it('RISK-02e: string.constructor.constructor should not reach Function', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var fn = ''.constructor.constructor('return typeof process')();
                    return fn;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val.startsWith('blocked'),
            'string constructor chain should be blocked, got: ' + val);
    });

    it('RISK-02f: RegExp.prototype.constructor should be neutered', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var ctor = /a/.constructor;
                    return typeof ctor;
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'undefined' || val === 'blocked',
            'RegExp constructor should be neutered, got: ' + val);
    });

    // --- RISK-03: Reflect removal ---

    it('RISK-03: Reflect should be removed from sandbox', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof Reflect;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // --- RegExp removal (M-07) ---

    it('M-07a: RegExp global should be undefined', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof RegExp;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    it('M-07b: regex literals should still work (V8 built-in)', async function() {
        // Regex literals are compiled by V8, not the RegExp constructor
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return /hello/.test('hello world');
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), true);
    });

    // --- Object.defineProperty removal ---

    it('should block Object.defineProperty inside contracts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Object.defineProperty({}, 'x', { get: function() { return 1; } });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('should block Object.defineProperties inside contracts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    Object.defineProperties({}, { x: { value: 1 } });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('should allow Object.create(null) but block descriptor argument', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var results = [];
                // Object.create(null) should work
                try {
                    var obj = Object.create(null);
                    results.push('create-null:ok');
                } catch(e) {
                    results.push('create-null:blocked');
                }
                // Object.create with descriptors should be blocked
                try {
                    Object.create(null, { x: { value: 1 } });
                    results.push('create-desc:ok');
                } catch(e) {
                    results.push('create-desc:blocked');
                }
                return results;
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val.includes('create-null:ok'), 'Object.create(null) should work');
        assert(val.includes('create-desc:blocked'), 'Object.create with descriptors should be blocked');
    });

    // --- Error.stack information leakage ---

    it('Error.stack should not reveal host file paths', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    throw new Error('test');
                } catch(e) {
                    return e.stack || 'no stack';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        // Should not contain host paths like /home, /usr, node_modules, etc.
        // Isolate stacks typically don't have host paths, but verify
        assert(!val.includes('/home/'), 'stack should not contain /home paths');
        assert(!val.includes('node_modules'), 'stack should not contain node_modules');
    });

    // --- __defineProperty cleanup ---

    it('__defineProperty should not be accessible to contract code', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof globalThis.__defineProperty;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });

    // --- __Function cleanup ---

    it('__Function should not be accessible to contract code', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return typeof globalThis.__Function;
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'undefined');
    });
});

// ===================================================================
// ERROR TYPE SPOOFING (RISK-04)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Error Type Spoofing', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-04a: \\x03REVERT prefix without actual revert should be generic error', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('\\x03REVERT:fake revert');
            };
        `);
        assert.strictEqual(result.success, false);
        // Should NOT be classified as a revert since execContext.reverted is false
        assert(!result.error.startsWith('revert:'),
            'should not be classified as revert, got: ' + result.error);
    });

    it('RISK-04b: \\x03GAS prefix without actual gas exhaustion should be generic error', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('\\x03GAS:999999:1000000');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(!result.error.startsWith('out_of_gas'),
            'should not be classified as out_of_gas, got: ' + result.error);
    });

    it('RISK-04c: caught revert followed by spoofed throw should use original reason', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.revert('real reason');
                } catch(e) {
                    // Swallowed the revert — execContext.reverted is now true
                }
                // Now try to spoof with a different reason
                throw new Error('\\x03REVERT:spoofed reason');
            };
        `);
        assert.strictEqual(result.success, false);
        // Should use the ORIGINAL revert reason, not the spoofed one
        assert(result.error.includes('real reason'),
            'should use original revert reason, got: ' + result.error);
        assert(!result.error.includes('spoofed reason'),
            'should not contain spoofed reason, got: ' + result.error);
    });

    it('RISK-04d: caught require failure followed by spoofed throw should use original reason', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    xchain.require(false, 'original check failed');
                } catch(e) {
                    // Swallowed
                }
                throw new Error('\\x03REVERT:injected');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('original check failed'),
            'should use original require reason, got: ' + result.error);
    });

    it('RISK-04e: return value \\x02 prefix should not be spoofable', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                return '\\x02{"spoofed":true}';
            };
        `);
        assert.strictEqual(result.success, true);
        // The \x02 prefix is handled by the contract wrapper, so the returned
        // value will be double-wrapped. Verify it's treated as a string, not parsed.
        if (result.returnValue !== null) {
            const parsed = JSON.parse(result.returnValue);
            // Should be the raw string, not the spoofed object
            assert(typeof parsed === 'string',
                'spoofed \\x02 return should be treated as string, got: ' + typeof parsed);
        }
    });
});

// ===================================================================
// GAS METERING BYPASS (RISK-05, RISK-06)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Gas Metering Bypass', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-06a: overwriting __gas should fail (non-writable)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    globalThis.__gas = function() {};
                    return 'overwrote';
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        // In strict mode, assignment to non-writable throws. In sloppy mode, silently fails.
        // Either way, __gas should still function — test with an infinite loop next.
        assert(val === 'blocked: Cannot assign to read only property \'__gas\' of object \'[object global]\'' ||
               val.startsWith('blocked') || val === 'overwrote',
            'got: ' + val);
    });

    it('RISK-06b: __gas should still meter after attempted overwrite', async function() {
        const vm2 = createVM({ gasCeiling: 500 });
        const result = await executeCode(vm2, `
            module.exports = function(xchain) {
                try { globalThis.__gas = function() {}; } catch(e) {}
                // If __gas was overwritten, this loop would run forever
                var sum = 0;
                for (var i = 0; i < 100000; i++) { sum += i; }
                return sum;
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('out_of_gas'),
            'should still enforce gas after overwrite attempt: ' + result.error);
    });

    it('RISK-06c: deleting __gas should fail (non-configurable)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    delete globalThis.__gas;
                    return typeof globalThis.__gas;
                } catch(e) {
                    return 'blocked: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val === 'function' || val.startsWith('blocked'),
            '__gas should survive deletion attempt, got: ' + val);
    });

    it('RISK-05a: getter traps should be blocked (Object.defineProperty removed)', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var obj = {};
                    Object.defineProperty(obj, 'trap', {
                        get: function() {
                            // Expensive unmetered computation
                            var sum = 0;
                            for (var i = 0; i < 1000000; i++) sum += i;
                            return sum;
                        }
                    });
                    return 'defineProperty available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });

    it('RISK-05b: Object.create with descriptors should be blocked', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                try {
                    var obj = Object.create(null, {
                        trap: { get: function() { return 42; } }
                    });
                    return 'available';
                } catch(e) {
                    return 'blocked';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'blocked');
    });
});

// ===================================================================
// PROTOTYPE POLLUTION (RISK-10, RISK-11)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Prototype Pollution', function() {

    // --- RISK-11: State key prototype pollution ---

    describe('State key prototype pollution (RISK-11)', function() {
        const StateManager = require('../../src/state.js');

        it('should safely handle __proto__ as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('__proto__', 'test_value');
            assert.strictEqual(sm.get('__proto__'), 'test_value');
            assert.strictEqual(sm.has('__proto__'), true);
        });

        it('should safely handle constructor as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('constructor', 'test_value');
            assert.strictEqual(sm.get('constructor'), 'test_value');
        });

        it('should safely handle hasOwnProperty as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('hasOwnProperty', 'test_value');
            assert.strictEqual(sm.get('hasOwnProperty'), 'test_value');
            // The state store should still function correctly
            assert.strictEqual(sm.has('hasOwnProperty'), true);
            assert.strictEqual(sm.has('nonexistent'), false);
        });

        it('should safely handle toString as a state key', function() {
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            sm.set('toString', 'test_value');
            assert.strictEqual(sm.get('toString'), 'test_value');
        });

        it('initial state with __proto__ key should not pollute prototype', function() {
            // When passing { '__proto__': 'injected' } as a literal, JS interprets
            // __proto__ as the prototype setter, so Object.entries won't see it.
            // Verify the state store itself is prototype-free (no inherited keys).
            const sm = new StateManager({}, {
                maxStateKeys: 100, maxStateValueSize: 65536, maxStateKeySize: 1024
            });
            // Set __proto__ via the state API — should be stored as a regular key
            sm.set('__proto__', 'injected');
            assert.strictEqual(sm.get('__proto__'), 'injected');
            assert.strictEqual(sm.has('__proto__'), true);
            // Verify it doesn't affect the state object's actual prototype
            assert.strictEqual(Object.getPrototypeOf(sm.state), null,
                'state store should have null prototype');
        });
    });

    // --- RISK-10: Emit parameter prototype pollution ---

    describe('Emit parameter prototype pollution (RISK-10)', function() {
        const EmissionCollector = require('../../src/collector.js');

        it('should strip __proto__ from emission params', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                __proto__: { polluted: true }
            });
            const actions = ec.getActions();
            assert.strictEqual(actions.length, 1);
            assert.strictEqual(actions[0].params.__proto__, undefined);
            // Verify normal params are preserved
            assert.strictEqual(actions[0].params.destination, 'addr1');
        });

        it('should strip constructor from emission params', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                constructor: 'evil'
            });
            const actions = ec.getActions();
            assert.strictEqual(actions[0].params.constructor, undefined);
        });

        it('should preserve normal params after stripping', function() {
            const ec = new EmissionCollector(50);
            ec.add('SEND', {
                destination: 'addr1',
                tick: 'TOKEN',
                quantity: '100',
                memo: 'hello'
            });
            const actions = ec.getActions();
            assert.strictEqual(actions[0].params.destination, 'addr1');
            assert.strictEqual(actions[0].params.tick, 'TOKEN');
            assert.strictEqual(actions[0].params.quantity, '100');
            assert.strictEqual(actions[0].params.memo, 'hello');
        });
    });
});

// ===================================================================
// EMIT PARAMETER TYPE VALIDATION (M-13)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Emit Parameter Type Validation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('should reject SEND with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 123, tick: 'T', quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject SEND with non-string tick', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 42, quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject SEND with non-string quantity', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: 100 });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject DESTROY with non-string tick', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.destroy({ tick: ['array'], quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject MINT with object quantity', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.mint({ tick: 'T', quantity: { value: '100' } });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject ORDER with non-string amounts', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.order({ giveAmount: 100, getAmount: '200' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should accept valid SEND with all string params', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.send({ destination: 'addr', tick: 'TOKEN', quantity: '100' });
                return 'ok';
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.emittedActions.length, 1);
    });

    it('should reject SWEEP with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.sweep({ destination: 12345 });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });

    it('should reject MESSAGE with non-string destination', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.message({ destination: null });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('missing required field'), 'got: ' + result.error);
    });

    it('should reject DIVIDEND with non-string fields', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.emit.dividend({ tick: 123, dividendTick: 'T', quantity: '1' });
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('must be a string'), 'got: ' + result.error);
    });
});

// ===================================================================
// MATH INPUT ABUSE (RISK-12)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Math Input Limits', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-12a: should reject math input longer than 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1';
                for (var i = 0; i < 300; i++) big += '0';
                try {
                    xchain.math.add(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        const val = JSON.parse(result.returnValue);
        assert(val.startsWith('rejected') && val.includes('maximum length'),
            'should reject oversized input, got: ' + val);
    });

    it('RISK-12b: should accept math input at exactly 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var num = '1';
                for (var i = 0; i < 255; i++) num += '0';
                try {
                    var r = xchain.math.add(num, '0');
                    return 'ok';
                } catch(e) {
                    return 'error: ' + e.message;
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'ok');
    });

    it('RISK-12c: should reject oversized input in divide', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1' + '0'.repeat(300);
                try {
                    xchain.math.divide(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    it('RISK-12d: should reject oversized input in compare', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '1' + '0'.repeat(300);
                try {
                    xchain.math.compare(big, '1');
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    it('RISK-12e: should reject oversized input in abs', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '-' + '1'.repeat(300);
                try {
                    xchain.math.abs(big);
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    it('RISK-12f: should reject oversized input in isZero', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var big = '0'.repeat(300);
                try {
                    xchain.math.isZero(big);
                    return 'accepted';
                } catch(e) {
                    return 'rejected';
                }
            };
        `);
        assert.strictEqual(result.success, true);
        assert.strictEqual(JSON.parse(result.returnValue), 'rejected');
    });

    // Unit-level math validation
    describe('Math module unit tests', function() {
        const { buildMathAPI } = require('../../src/math.js');
        const math = buildMathAPI();

        it('should accept normal numeric strings', function() {
            assert.strictEqual(math.add('100', '200'), '300');
        });

        it('should reject input exceeding 256 chars', function() {
            const big = '1' + '0'.repeat(300);
            assert.throws(() => math.add(big, '1'), /maximum length/);
        });

        it('should reject oversized second argument', function() {
            const big = '1' + '0'.repeat(300);
            assert.throws(() => math.add('1', big), /maximum length/);
        });
    });
});

// ===================================================================
// INFORMATION LEAKAGE (RISK-15)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Information Leakage', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-15a: generic error should not contain stack traces', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                // Throw an error that would normally have a stack trace
                throw new Error('something went wrong');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.includes('something went wrong'), 'should contain error message');
        assert(!result.error.includes('\n'), 'should not contain newlines (stack trace)');
    });

    it('RISK-15b: error should be truncated to 256 chars', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('x'.repeat(500));
            };
        `);
        assert.strictEqual(result.success, false);
        // "error: " prefix + truncated message
        assert(result.error.length <= 263, 'error should be truncated, length: ' + result.error.length);
    });

    it('RISK-15c: error with file paths should have paths stripped', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                throw new Error('failed at /home/user/app/src/module.js:42:10');
            };
        `);
        assert.strictEqual(result.success, false);
        assert(!result.error.includes('/home/user'),
            'should strip file paths, got: ' + result.error);
    });

    it('RISK-15d: revert error should preserve user reason without sanitization', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.revert('insufficient balance for transfer');
            };
        `);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'revert: insufficient balance for transfer');
    });

    it('RISK-15e: out_of_gas error should use tracker values not error message', async function() {
        const vm2 = createVM({ gasCeiling: 100 });
        const result = await executeCode(vm2, `
            module.exports = function(xchain) {
                var sum = 0;
                for (var i = 0; i < 10000; i++) sum += i;
                return sum;
            };
        `);
        assert.strictEqual(result.success, false);
        assert(result.error.startsWith('out_of_gas'), 'should be out of gas: ' + result.error);
    });
});

// ===================================================================
// STATE ISOLATION (RISK-13)
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: State Isolation', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('RISK-13a: sequential executions should not share state', async function() {
        // First execution writes state
        const r1 = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.state.set('leaked', 'secret');
                return 'written';
            };
        `);
        assert.strictEqual(r1.success, true);

        // Second execution should not see the state (different contract, no state passed)
        const r2 = await executeCode(vm, `
            module.exports = function(xchain) {
                return xchain.state.get('leaked');
            };
        `);
        assert.strictEqual(r2.success, true);
        assert.strictEqual(r2.returnValue, 'null');
    });

    it('RISK-13b: compilation cache should not leak between contracts', async function() {
        vm.beginBlock();
        try {
            // Execute contract A
            const r1 = await executeCode(vm, `
                module.exports = function(xchain) { return 'contract_a'; };
            `, { contractAddress: 'C:BTC:A' });
            assert.strictEqual(r1.success, true);

            // Execute contract B (different code)
            const r2 = await executeCode(vm, `
                module.exports = function(xchain) { return 'contract_b'; };
            `, { contractAddress: 'C:BTC:B' });
            assert.strictEqual(r2.success, true);

            // Results should differ
            assert.strictEqual(JSON.parse(r1.returnValue), 'contract_a');
            assert.strictEqual(JSON.parse(r2.returnValue), 'contract_b');
        } finally {
            vm.endBlock();
        }
    });

    it('RISK-13c: failed execution should not persist state changes', async function() {
        const r = await executeCode(vm, `
            module.exports = function(xchain) {
                xchain.state.set('key1', 'value1');
                xchain.state.set('key2', 'value2');
                xchain.emit.send({ destination: 'addr', tick: 'T', quantity: '100' });
                xchain.revert('rollback');
            };
        `);
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.stateChanges.length, 0, 'no state changes on revert');
        assert.strictEqual(r.stateDeletes.length, 0, 'no state deletes on revert');
        assert.strictEqual(r.emittedActions.length, 0, 'no emissions on revert');
    });
});

// ===================================================================
// COMPREHENSIVE SANDBOX ESCAPE BATTERY
// ===================================================================

(XChainVM ? describe : describe.skip)('Security: Comprehensive Escape Battery', function() {
    this.timeout(15000);

    let vm;
    before(function() { vm = createVM(); });

    const escapeVectors = [
        {
            name: 'this.constructor.constructor',
            code: `try { var fn = this.constructor.constructor('return typeof process')(); return fn; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'Object.getPrototypeOf chain',
            code: `try { var p = Object.getPrototypeOf({}); var c = p.constructor; return typeof c; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'arguments.callee.constructor',
            code: `try { return typeof arguments.callee.constructor; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'import expression',
            code: `try { return typeof import; } catch(e) { return 'blocked'; }`
        },
        {
            name: 'globalThis enumeration for dangerous refs',
            code: `
                var dangerous = ['process', 'require', 'eval', 'Function',
                    '__Function', '__defineProperty', 'Proxy', 'Reflect',
                    'Date', 'setTimeout', 'setInterval', 'fetch'];
                var found = [];
                for (var i = 0; i < dangerous.length; i++) {
                    if (typeof globalThis[dangerous[i]] !== 'undefined')
                        found.push(dangerous[i]);
                }
                return found.length === 0 ? 'clean' : 'found: ' + found.join(',');
            `
        }
    ];

    for (const vec of escapeVectors) {
        it('should block: ' + vec.name, async function() {
            const code = `module.exports = function(xchain) { ${vec.code} };`;
            let result;
            try {
                result = await executeCode(vm, code);
            } catch (e) {
                // If it throws at compilation level, that's fine too
                return;
            }
            if (result.success) {
                const val = JSON.parse(result.returnValue);
                assert(val === 'undefined' || val === 'blocked' || val === 'clean' || val === null,
                    vec.name + ' should be blocked, got: ' + val);
            }
            // If result.success is false, the contract errored — also acceptable
        });
    }

    it('should verify no __* globals leak to contract scope', async function() {
        const result = await executeCode(vm, `
            module.exports = function(xchain) {
                var leaks = [];
                var names = Object.getOwnPropertyNames(globalThis);
                for (var i = 0; i < names.length; i++) {
                    if (names[i].indexOf('__') === 0 && names[i] !== '__gas') {
                        leaks.push(names[i]);
                    }
                }
                return leaks;
            };
        `);
        assert.strictEqual(result.success, true);
        const leaks = JSON.parse(result.returnValue);
        assert.deepStrictEqual(leaks, [],
            'no __* globals should be visible except __gas, found: ' + leaks.join(', '));
    });
});
