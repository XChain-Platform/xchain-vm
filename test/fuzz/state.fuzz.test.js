/*********************************************************************
 * Fuzz Tests — State Operations
 *
 * Tests that adversarial keys, values, and state operation sequences
 * never corrupt state, crash the VM, or pollute prototypes.
 ********************************************************************/

const fc = require('fast-check');
const assert = require('assert');
const { XChainVM, createVM, execute, FC_OPTIONS, DEFAULT_LIMITS } = require('./harness');
const { checkResultShape, checkAtomicity, checkStateLimits, checkNoPrototypePollution, checkAll } = require('./invariants');
const {
    stateContractArb, deleteSetCycleArb, stateFloodContractArb,
    largeValueContractArb, initialStateArb
} = require('./generators/state');

(XChainVM ? describe : describe.skip)('Fuzz: State', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    it('adversarial key/value pairs never crash the VM', async function() {
        await fc.assert(fc.asyncProperty(stateContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('null and undefined values are rejected, not accepted silently', async function() {
        const nullContract = `module.exports = function(xchain) {
            xchain.state.set('key', null);
        };`;
        const undefContract = `module.exports = function(xchain) {
            xchain.state.set('key', undefined);
        };`;

        const r1 = await execute(vm, nullContract);
        checkResultShape(r1);
        assert.strictEqual(r1.success, false, 'null value should fail');
        checkAtomicity(r1);

        const r2 = await execute(vm, undefContract);
        checkResultShape(r2);
        assert.strictEqual(r2.success, false, 'undefined value should fail');
        checkAtomicity(r2);
    });

    it('NaN and Infinity values are rejected', async function() {
        const nanContract = `module.exports = function(xchain) {
            xchain.state.set('key', NaN);
        };`;
        const infContract = `module.exports = function(xchain) {
            xchain.state.set('key', Infinity);
        };`;

        const r1 = await execute(vm, nanContract);
        assert.strictEqual(r1.success, false, 'NaN value should fail');

        const r2 = await execute(vm, infContract);
        assert.strictEqual(r2.success, false, 'Infinity value should fail');
    });

    it('keys exceeding maxStateKeySize are rejected', async function() {
        const longKey = 'k'.repeat(DEFAULT_LIMITS.maxStateKeySize + 1);
        const code = `module.exports = function(xchain) {
            xchain.state.set(${JSON.stringify(longKey)}, 'value');
        };`;
        const result = await execute(vm, code);
        checkResultShape(result);
        assert.strictEqual(result.success, false, 'Oversized key should fail');
        checkAtomicity(result);
    });

    it('values exceeding maxStateValueSize are rejected', async function() {
        await fc.assert(fc.asyncProperty(largeValueContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkStateLimits(result, DEFAULT_LIMITS);
        }), FC_OPTIONS);
    });

    it('state flood beyond maxStateKeys fails atomically', async function() {
        const smallLimitVM = createVM({ maxStateKeys: 50 });
        await fc.assert(fc.asyncProperty(stateFloodContractArb, async (code) => {
            const result = await execute(smallLimitVM, code);
            checkResultShape(result);
            checkAtomicity(result);
        }), FC_OPTIONS);
    });

    it('delete-set cycles do not corrupt keyCount', async function() {
        await fc.assert(fc.asyncProperty(deleteSetCycleArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            // If successful, the final state should have the key
            if (result.success) {
                assert(result.stateChanges.length > 0, 'Should have state changes');
            }
        }), FC_OPTIONS);
    });

    it('prototype-poisoning keys do not pollute host', async function() {
        const poisonKeys = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'];
        for (const key of poisonKeys) {
            const code = `module.exports = function(xchain) {
                xchain.state.set(${JSON.stringify(key)}, 'injected');
                return xchain.state.get(${JSON.stringify(key)});
            };`;
            const result = await execute(vm, code);
            checkResultShape(result);
            checkNoPrototypePollution();
        }
    });

    it('initial state with adversarial keys does not affect host', async function() {
        await fc.assert(fc.asyncProperty(initialStateArb, async (state) => {
            const code = `module.exports = function(xchain) {
                return xchain.state.get('nonexistent');
            };`;
            const result = await execute(vm, code, { state });
            checkResultShape(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('state read returns correct value from initialState', async function() {
        await fc.assert(fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.string({ minLength: 1, maxLength: 100 }),
            async (key, value) => {
                // Build initialState with a null prototype so adversarial keys
                // like "__proto__" become genuine own properties. A plain {}
                // would route state["__proto__"] = "str" through the __proto__
                // setter (a no-op for non-object values), silently dropping the
                // key before it ever reaches the VM — a false failure that masks
                // what we actually want to test: round-trip fidelity for every key.
                const state = Object.create(null);
                state[key] = value;
                const code = `module.exports = function(xchain) {
                    return xchain.state.get(${JSON.stringify(key)});
                };`;
                const result = await execute(vm, code, { state });
                checkResultShape(result);
                if (result.success && result.returnValue) {
                    const returned = JSON.parse(result.returnValue);
                    assert.strictEqual(returned, value,
                        'State read returned wrong value for key: ' + key);
                }
            }
        ), FC_OPTIONS);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
