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
 * XChain VM Gateway: metered accessors
 *
 * The read-side slices of the xchain gateway object: block context and
 * inputs, ledger and poll reads, contract state, oracle and cross-chain
 * reads. Each builder returns the members it owns, in gateway order, for
 * buildGateway (../gateway.js) to spread into the one gateway object.
 ********************************************************************/
// @ts-nocheck

// The top-level context accessors (0 gas) and the metered ledger and poll
// reads, returned as gateway members.
function buildContextAPI(gasTracker, readOnlyData, gasSchedule) {
    return {
        // Read-only context (0 gas)
        getBlockHeight:     () => readOnlyData.blockContext.height,
        getBlockTimestamp:   () => readOnlyData.blockContext.timestamp,
        getBlockHash:        () => readOnlyData.blockContext.hash,
        getSourceAddress:    () => readOnlyData.caller,
        getContractAddress:  () => readOnlyData.contractAddress,
        getInputParams:      () => [...readOnlyData.params],
        getInputParam:       (i) => readOnlyData.params[i] !== undefined ? readOnlyData.params[i] : null,
        getInputParamCount:  () => readOnlyData.params.length,
        // Cross-contract call depth: 0 for a user-submitted EXECUTE, parent+1 for
        // a run reached via emit.execute. Lets library contracts guard themselves
        // before emit.execute throws at the max-depth gate.
        getCallDepth:        () => Number.isInteger(readOnlyData.callDepth) ? readOnlyData.callDepth : 0,
        getCrossHops:        () => Number.isInteger(readOnlyData.crossHops) ? readOnlyData.crossHops : 0,

        // Read-only ledger queries (100 gas each)
        getBalance: (address, tick) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.balances) return null;
            return readOnlyData.balances[address]?.[tick] || null;
        },
        getTokenInfo: (tick) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.tokenInfo) return null;
            return readOnlyData.tokenInfo[tick] || null;
        },
        // Frozen result of a finalized VOTE governance poll (the governance hook:
        // a contract branches on a poll outcome - release a treasury, flip a
        // parameter). Returns null for an unknown or not-yet-finalized poll, so a
        // contract can tell "not decided" from a real result. Deterministic: the
        // result is immutable post-finalization and identical on every node.
        getPollResult: (pollIndex) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.pollData) return null;
            return readOnlyData.pollData.getPollResult(pollIndex);
        }
    };
}

// The contract state namespace: every read, write and delete is metered.
function buildStateAPI(gasTracker, stateManager, gasSchedule) {
    return {
        // Contract state (metered)
        state: {
            get: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                return stateManager.get(key);
            },
            has: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                return stateManager.has(key);
            },
            set: (key, value) => {
                gasTracker.charge(gasSchedule.VM_STATE_WRITE);
                stateManager.set(key, value);
            },
            delete: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_DELETE);
                return stateManager.delete(key);
            }
        }
    };
}

// The oracle namespace: price reads, and the gas-free snapshot age.
function buildOracleAPI(gasTracker, readOnlyData, gasSchedule) {
    return {
        // Oracle. getPrice/getPriceAtRound are metered (VM_ORACLE_READ, 100 gas
        // each). getSnapshotAge is INTENTIONALLY gas-free, like the zero-gas
        // context accessors: its value is deterministic across all nodes, each
        // call site is already bounded by control-flow gas, and the gas-free
        // behavior is pinned by test/unit/gateway/gateway.test.js (charging it would be
        // a consensus gas-schedule change).
        oracle: {
            getPrice: (coinPair) => {
                gasTracker.charge(gasSchedule.VM_ORACLE_READ);
                if (!readOnlyData.oracleData) return null;
                return readOnlyData.oracleData.getPrice(coinPair);
            },
            getPriceAtRound: (coinPair, roundNumber) => {
                gasTracker.charge(gasSchedule.VM_ORACLE_READ);
                if (!readOnlyData.oracleData) return null;
                return readOnlyData.oracleData.getPriceAtRound(coinPair, roundNumber);
            },
            // Gas-free by design (see the oracle group comment above).
            getSnapshotAge: () => {
                if (!readOnlyData.oracleData) return Number.MAX_SAFE_INTEGER;
                return readOnlyData.oracleData.getSnapshotAge();
            }
        }
    };
}

// The cross-chain namespace: attestation, settlement and call-result reads.
function buildCrossChainAPI(gasTracker, readOnlyData, gasSchedule) {
    return {
        // Cross-chain (metered)
        crossChain: {
            getAttestation: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.getAttestation(chain, actionIndex) || null;
            },
            isSettled: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.isSettled(chain, actionIndex) || false;
            },
            // Outcome of a cross-chain call THIS chain originated:
            // { status, payload } once terminal (visible the block after it
            // resolved), null while in flight. The callback (emit.crossExecute's
            // callbackMethod) is the primary delivery; this read backs
            // idempotency checks and late consumers.
            getCallResult: (callId) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.getCallResult(callId) || null;
            }
        }
    };
}

module.exports = { buildContextAPI, buildStateAPI, buildOracleAPI, buildCrossChainAPI };
