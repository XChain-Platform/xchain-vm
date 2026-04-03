/*********************************************************************
 * Fuzz Tests — Determinism
 *
 * Verifies that identical inputs produce byte-identical results
 * across two independent VM instances. Any difference indicates a
 * consensus-critical non-determinism bug.
 ********************************************************************/

const fc = require('fast-check');
const { XChainVM, createVM, execute, hashResult, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkDeterminism, checkNoPrototypePollution } = require('./invariants');
const { validContractArb, mutatedContractArb, anyCodeArb } = require('./generators/code');
const { safeNumericStringArb, buildMathContract, MATH_ALL_OPS } = require('./generators/math');
const { initialStateArb } = require('./generators/state');

(XChainVM ? describe : describe.skip)('Fuzz: Determinism', function() {
    this.timeout(120000);

    it('valid contracts produce identical results on two VMs', async function() {
        await fc.assert(fc.asyncProperty(validContractArb, async (code) => {
            const vm1 = createVM();
            const vm2 = createVM();
            const opts = { params: ['test'], state: { init: 'value' } };
            const [r1, r2] = await Promise.all([
                execute(vm1, code, opts),
                execute(vm2, code, opts)
            ]);
            checkResultShape(r1);
            checkResultShape(r2);
            checkDeterminism(r1, r2, hashResult);
        }), FC_OPTIONS);
    });

    it('mutated contracts (including failures) are deterministic', async function() {
        await fc.assert(fc.asyncProperty(mutatedContractArb, async (code) => {
            const vm1 = createVM();
            const vm2 = createVM();
            const [r1, r2] = await Promise.all([
                execute(vm1, code),
                execute(vm2, code)
            ]);
            checkResultShape(r1);
            checkResultShape(r2);
            checkDeterminism(r1, r2, hashResult);
        }), FC_OPTIONS);
    });

    it('gas usage is identical across runs', async function() {
        await fc.assert(fc.asyncProperty(anyCodeArb, async (code) => {
            const vm1 = createVM();
            const vm2 = createVM();
            const [r1, r2] = await Promise.all([
                execute(vm1, code),
                execute(vm2, code)
            ]);
            if (r1.gasUsed !== r2.gasUsed) {
                throw new Error('Gas usage differs: ' + r1.gasUsed + ' vs ' + r2.gasUsed);
            }
        }), FC_OPTIONS);
    });

    it('math operations with edge-case inputs are deterministic', async function() {
        await fc.assert(fc.asyncProperty(
            fc.constantFrom(...MATH_ALL_OPS),
            safeNumericStringArb,
            safeNumericStringArb,
            async (op, a, b) => {
                const code = buildMathContract(op, a, b);
                const vm1 = createVM();
                const vm2 = createVM();
                const [r1, r2] = await Promise.all([
                    execute(vm1, code),
                    execute(vm2, code)
                ]);
                checkDeterminism(r1, r2, hashResult);
            }
        ), FC_OPTIONS);
    });

    it('initial state variations are deterministic', async function() {
        await fc.assert(fc.asyncProperty(initialStateArb, async (state) => {
            const code = `module.exports = function(xchain) {
                var keys = [];
                var vals = [];
                var testKeys = ${JSON.stringify(Object.keys(state || {}))};
                for (var i = 0; i < testKeys.length; i++) {
                    var v = xchain.state.get(testKeys[i]);
                    if (v !== null) { keys.push(testKeys[i]); vals.push(v); }
                }
                return { keys: keys, vals: vals };
            };`;
            const vm1 = createVM();
            const vm2 = createVM();
            const [r1, r2] = await Promise.all([
                execute(vm1, code, { state }),
                execute(vm2, code, { state })
            ]);
            checkResultShape(r1);
            checkResultShape(r2);
            checkDeterminism(r1, r2, hashResult);
        }), FC_OPTIONS);
    });

    it('block context is consistently accessible', async function() {
        const code = `module.exports = function(xchain) {
            return {
                h: xchain.getBlockHeight(),
                t: xchain.getBlockTimestamp(),
                b: xchain.getBlockHash()
            };
        };`;
        const blockContext = { height: 999, timestamp: 1700000000, hash: 'deterministic_hash' };
        const vm1 = createVM();
        const vm2 = createVM();
        const [r1, r2] = await Promise.all([
            execute(vm1, code, { blockContext }),
            execute(vm2, code, { blockContext })
        ]);
        checkDeterminism(r1, r2, hashResult);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
