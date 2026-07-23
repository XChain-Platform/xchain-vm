/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Fuzz Testing Harness
 *
 * Shared VM factory, execute wrapper, and configuration for all
 * fuzz test files. Handles isolated-vm availability gracefully.
 ********************************************************************/
// @ts-nocheck

// 


const crypto = require('crypto');

const GAS_SCHEDULE = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_EMISSION:        500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
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
    // isolated-vm not compiled; tests will be skipped
}

const FUZZ_ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS || '500', 10);

// Reproducible fuzzing. fast-check only prints the seed it used ON FAILURE,
// so a flake whose output scrolls away (or a non-endOnFailure run) is
// unrecoverable. We therefore choose the seed ourselves, LOG it up front
// every run, and let it be pinned via FC_SEED. A green run still logs its
// seed, so when a future run goes red you can reproduce the exact input
// stream with `FC_SEED=<that number> npm run test:fuzz`. Default stays
// random for broad coverage; CI can pin for full determinism.
const FC_SEED = process.env.FC_SEED
    ? parseInt(process.env.FC_SEED, 10)
    : (Date.now() >>> 0);
// eslint-disable-next-line no-console -- fuzz harness logs the chosen seed for reproducibility
console.log(`[fuzz] fast-check seed = ${FC_SEED}` +
    (process.env.FC_SEED ? ' (pinned via FC_SEED)' : ' (random; pin with FC_SEED=<n> to reproduce)'));

const FC_OPTIONS = {
    numRuns:      FUZZ_ITERATIONS,
    endOnFailure: true,
    seed:         FC_SEED
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
        execution: 'in-process',  // explicit: containment not needed in unit/fuzz harnesses
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
        // Optional network passthrough (undefined = mainnet-conservative, the prior
        // behaviour for every caller that omits it). Lets a test exercise the
        // network-aware execution gates (async-surface, musl stack depth, ...).
        network:         extraOpts?.network,
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
        // vm.execute() should never throw. If it does, that is itself a bug.
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

// Consensus-status projection of a VM error. The resource-exhaustion family
// (out_of_gas / timeout / out_of_memory / out_of_stack / out_of_resource) is a
// host-timing race over WHICH ceiling fires (gas ceiling vs wall-clock net vs
// parent watchdog), not a consensus input. The indexer collapses the whole
// family to one status_id (xchain-indexer src/utility.js vmFailureStatus), which
// is what actually gets hashed into contract_hash. The determinism guard hashes
// the SAME collapsed projection so it asserts the real consensus invariant
// instead of flaking on the race. revert / runtime-error / null text is left
// untouched (those are deterministic and not host-timing races).
function consensusError(error) {
    if (/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(error || ''))) {
        return 'out_of_resource';
    }
    return error;
}

function hashResult(result) {
    const normalized = {
        success:        result.success,
        error:          consensusError(result.error),
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
    FC_SEED,
    FC_OPTIONS,
    createVM,
    execute,
    hashResult,
    consensusError
};
