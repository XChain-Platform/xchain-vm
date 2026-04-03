/*********************************************************************
 * Fuzz Testing Harness
 *
 * Shared VM factory, execute wrapper, and configuration for all
 * fuzz test files. Handles isolated-vm availability gracefully.
 ********************************************************************/

const crypto = require('crypto');

const GAS_SCHEDULE = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_EMISSION:        500
};

const DEFAULT_LIMITS = {
    maxCpuTimeMs:      500,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxCodeSize:       65536,
    maxStateKeySize:   1024,
    maxBlockCacheSize: 1000
};

const DEFAULT_BLOCK_CONTEXT = { height: 100, timestamp: 1700000000, hash: 'abc123' };

let XChainVM = null;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    // isolated-vm not compiled — tests will be skipped
}

const FUZZ_ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS || '500', 10);

const FC_OPTIONS = {
    numRuns:    FUZZ_ITERATIONS,
    endOnFailure: true
};

function createVM(overrides) {
    if (!XChainVM) throw new Error('isolated-vm not available');
    const limits = { ...DEFAULT_LIMITS };
    if (overrides) {
        for (const key of Object.keys(overrides)) {
            if (key in limits) limits[key] = overrides[key];
        }
    }
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling:  overrides?.gasCeiling || 1000000,
        limits
    });
}

async function execute(vm, code, extraOpts) {
    const opts = {
        code:            code,
        state:           extraOpts?.state || {},
        method:          extraOpts?.method || 'default',
        params:          extraOpts?.params || [],
        caller:          extraOpts?.caller || 'test_addr',
        contractAddress: extraOpts?.contractAddress || 'C:BTC:1',
        blockContext:    extraOpts?.blockContext || DEFAULT_BLOCK_CONTEXT,
        balances:        extraOpts?.balances,
        tokenInfo:       extraOpts?.tokenInfo,
        oracleData:      extraOpts?.oracleData,
        crossChainData:  extraOpts?.crossChainData,
        contractIndex:   extraOpts?.contractIndex
    };
    try {
        return await vm.execute(opts);
    } catch (e) {
        // vm.execute() should never throw — if it does, that is itself a bug.
        // Return a synthetic error result so invariant checkers can flag it.
        return {
            success:        false,
            error:          'HARNESS_CAUGHT_THROW: ' + e.message,
            gasUsed:        0,
            returnValue:    null,
            stateChanges:   [],
            stateDeletes:   [],
            emittedActions: [],
            logs:           []
        };
    }
}

function hashResult(result) {
    const normalized = {
        success:        result.success,
        error:          result.error,
        gasUsed:        result.gasUsed,
        returnValue:    result.returnValue,
        stateChanges:   (result.stateChanges || []).slice().sort((a, b) => (a.key || '').localeCompare(b.key || '')),
        stateDeletes:   (result.stateDeletes || []).slice().sort(),
        emittedActions: result.emittedActions,
        logs:           result.logs
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

module.exports = {
    GAS_SCHEDULE,
    DEFAULT_LIMITS,
    DEFAULT_BLOCK_CONTEXT,
    XChainVM,
    FUZZ_ITERATIONS,
    FC_OPTIONS,
    createVM,
    execute,
    hashResult
};
