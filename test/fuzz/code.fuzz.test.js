/*********************************************************************
 * Fuzz Tests — Contract Code
 *
 * Tests that valid, mutated, and adversarial contract code never
 * crashes the host process and always produces correct result shapes.
 ********************************************************************/

const fc = require('fast-check');
const { XChainVM, createVM, execute, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkAtomicity, checkGasCeiling, checkNoPrototypePollution, checkAll } = require('./invariants');
const { validContractArb, mutatedContractArb, adversarialCodeArb, anyCodeArb } = require('./generators/code');

(XChainVM ? describe : describe.skip)('Fuzz: Code', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    it('valid contracts always produce correct result shape', async function() {
        await fc.assert(fc.asyncProperty(validContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkGasCeiling(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('mutated contracts never crash the host', async function() {
        await fc.assert(fc.asyncProperty(mutatedContractArb, async (code) => {
            const result = await execute(vm, code);
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('adversarial code maintains invariants', async function() {
        await fc.assert(fc.asyncProperty(adversarialCodeArb, async (code) => {
            const result = await execute(vm, code);
            checkAll(result);
        }), FC_OPTIONS);
    });

    it('gas spoof attempts do not produce false out_of_gas', async function() {
        const spoofCode = 'module.exports = function(xchain) { throw new Error("\\x03GAS:999999:1"); };';
        const result = await execute(vm, spoofCode);
        checkResultShape(result);
        // The error should NOT be classified as out_of_gas since gas was not actually exhausted
        if (result.error && result.error.includes('out_of_gas')) {
            throw new Error('Gas spoof succeeded — error classified as out_of_gas without actual exhaustion');
        }
    });

    it('revert spoof attempts do not produce false reverts', async function() {
        const spoofCode = 'module.exports = function(xchain) { throw new Error("\\x03REVERT:spoofed"); };';
        const result = await execute(vm, spoofCode);
        checkResultShape(result);
        // The error should NOT be classified as a revert since execContext.reverted was not set
        if (result.error && result.error.startsWith('revert:')) {
            throw new Error('Revert spoof succeeded — error classified as revert without actual revert');
        }
    });

    it('serialization markers in return value are handled safely', async function() {
        const markers = ['\x01', '\x02', '\x03'];
        for (const marker of markers) {
            const code = 'module.exports = function(xchain) { return "' + marker + 'payload"; };';
            const result = await execute(vm, code);
            checkResultShape(result);
            // returnValue must be valid JSON-parseable or null
            if (result.returnValue !== null) {
                try {
                    JSON.parse(result.returnValue);
                } catch (e) {
                    throw new Error('returnValue is not valid JSON: ' + result.returnValue);
                }
            }
        }
    });

    it('any code input maintains all invariants', async function() {
        await fc.assert(fc.asyncProperty(anyCodeArb, async (code) => {
            const result = await execute(vm, code);
            checkAll(result);
        }), FC_OPTIONS);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
