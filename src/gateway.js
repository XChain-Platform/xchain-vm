/*********************************************************************
 * XChain VM — Gateway Builder
 *
 * Builds the xchain gateway object that contracts interact with.
 * Every state/ledger/emission method is gas-metered.
 *
 * This module returns a plain JS object on the host side.
 * The index.js module wraps each method as an ivm.Reference
 * before injecting into the isolate.
 ********************************************************************/

const { ContractRevertError } = require('./errors.js');
const { buildEmitAPI } = require('./gateway-emit.js');
const { buildMathAPI } = require('./math.js');

/**
 * Build the gateway object for contract execution.
 * @param {GasTracker} gasTracker
 * @param {StateManager} stateManager
 * @param {EmissionCollector} emissionCollector
 * @param {object} readOnlyData - { caller, contractAddress, params, blockContext, balances, tokenInfo, oracleData, crossChainData }
 * @param {object} gasSchedule
 * @param {object} execContext - Shared execution context { reverted: false }
 * @returns {object} The xchain gateway object
 */
function buildGateway(gasTracker, stateManager, emissionCollector, readOnlyData, gasSchedule, execContext) {
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
        },

        // Oracle (metered, 100 gas each)
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
            getSnapshotAge: () => {
                if (!readOnlyData.oracleData) return Number.MAX_SAFE_INTEGER;
                return readOnlyData.oracleData.getSnapshotAge();
            }
        },

        // Cross-chain (Phase 4, metered)
        crossChain: {
            getAttestation: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.getAttestation(chain, actionIndex) || null;
            },
            isSettled: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.isSettled(chain, actionIndex) || false;
            }
        },

        // Action emission (metered, 500 gas each)
        emit: buildEmitAPI(gasTracker, emissionCollector, gasSchedule),

        // Deterministic math (wraps mathjs bignumber)
        math: buildMathAPI(),

        // Control flow (gas-free)
        // Store the revert reason in execContext so the error classifier can
        // verify it matches — prevents spoofing via caught reverts (RISK-04).
        revert: (reason) => {
            const r = reason || 'reverted';
            if (execContext) {
                execContext.reverted = true;
                execContext.revertReason = r;
            }
            throw new ContractRevertError(r);
        },
        require: (condition, reason) => {
            if (!condition) {
                const r = reason || 'requirement failed';
                if (execContext) {
                    execContext.reverted = true;
                    execContext.revertReason = r;
                }
                throw new ContractRevertError(r);
            }
        },

        // Debug logging (gas-free, capped at 100 entries)
        log: (...args) => {
            emissionCollector.addLog(args.map(String).join(' '));
        },
        isLogFull: () => emissionCollector.isLogFull(),
        getLogCount: () => emissionCollector.getLogCount()
    };
}

module.exports = { buildGateway };
