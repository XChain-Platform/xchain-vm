/*********************************************************************
 * Fuzz Tests — Contract Function Arguments
 *
 * Tests that any params array passed to vm.execute() produces a
 * well-shaped result and never crashes the VM.
 ********************************************************************/

const fc = require('fast-check');
const { XChainVM, createVM, execute, FC_OPTIONS } = require('./harness');
const { checkResultShape, checkAtomicity, checkNoPrototypePollution } = require('./invariants');
const { normalParamsArb, adversarialParamsArb, mixedParamsArb } = require('./generators/args');

const ECHO_CONTRACT = `module.exports = function(xchain) {
    return {
        count: xchain.getInputParamCount(),
        first: xchain.getInputParam(0),
        all: xchain.getInputParams()
    };
};`;

const PARAM_ACCESS_CONTRACT = `module.exports = function(xchain) {
    var results = [];
    var count = xchain.getInputParamCount();
    for (var i = 0; i < count + 5; i++) {
        results.push(xchain.getInputParam(i));
    }
    return results;
};`;

(XChainVM ? describe : describe.skip)('Fuzz: Arguments', function() {
    this.timeout(120000);
    let vm;

    before(function() { vm = createVM(); });

    it('any params array produces a well-shaped result', async function() {
        await fc.assert(fc.asyncProperty(mixedParamsArb, async (params) => {
            const result = await execute(vm, ECHO_CONTRACT, { params });
            checkResultShape(result);
            checkAtomicity(result);
            checkNoPrototypePollution();
        }), FC_OPTIONS);
    });

    it('out-of-bounds getInputParam returns null, never throws', async function() {
        await fc.assert(fc.asyncProperty(normalParamsArb, async (params) => {
            const result = await execute(vm, PARAM_ACCESS_CONTRACT, { params });
            checkResultShape(result);
            if (result.success && result.returnValue) {
                const arr = JSON.parse(result.returnValue);
                // Elements beyond params.length should be null
                for (let i = params.length; i < arr.length; i++) {
                    if (arr[i] !== null) {
                        throw new Error('getInputParam(' + i + ') returned ' + arr[i] + ' instead of null');
                    }
                }
            }
        }), FC_OPTIONS);
    });

    it('protocol markers in params do not corrupt results', async function() {
        await fc.assert(fc.asyncProperty(adversarialParamsArb, async (params) => {
            const result = await execute(vm, ECHO_CONTRACT, { params });
            checkResultShape(result);
            checkAtomicity(result);
            // If successful, returnValue must be valid JSON
            if (result.success && result.returnValue) {
                try {
                    JSON.parse(result.returnValue);
                } catch (e) {
                    throw new Error('returnValue is not valid JSON after adversarial params');
                }
            }
        }), FC_OPTIONS);
    });

    it('context accessors with various params have minimal gas cost', async function() {
        const contextContract = `module.exports = function(xchain) {
            return xchain.getInputParamCount();
        };`;
        await fc.assert(fc.asyncProperty(mixedParamsArb, async (params) => {
            const result = await execute(vm, contextContract, { params });
            checkResultShape(result);
            // Context accessors are gas-free, only metering charges gas
            // Gas should be relatively low regardless of param count
            if (result.success && result.gasUsed > 10000) {
                throw new Error('Unexpectedly high gas (' + result.gasUsed + ') for context-only contract');
            }
        }), FC_OPTIONS);
    });

    after(function() {
        checkNoPrototypePollution();
    });
});
