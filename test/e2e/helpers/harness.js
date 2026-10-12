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
 * E2E Test Harness: Orchestrates deploy/execute cycles
 *
 * Wraps the real XChainVM with a MockLedger and MockIndexer to
 * simulate the full platform pipeline.
 ********************************************************************/
// @ts-nocheck

const fs   = require('fs');
const path = require('path');
const MockLedger  = require('./MockLedger.js');
const MockIndexer = require('./MockIndexer.js');

// Fee and limit defaults and the chain anchors load with the VM. Guarded so a
// host without isolated-vm still loads this module and its suites skip, as before.
let SIM = null, GATES = null, SIM_LOAD_ERROR = null;
try {
    SIM   = require('../../../src/toolkit/simulator.js');
    GATES = require('../../../src/toolkit/simulator/block_time_gates.js');
} catch (e) { SIM_LOAD_ERROR = e; }

// Wall budget kept tighter than the simulator's so a runaway contract fails fast;
// the VM honours it only below the consensus wall-clock gate (wallClockBudgetMs).
const E2E_MAX_CPU_TIME_MS = 5000;

// The simulator's frozen schedule itself, never a retyped copy, so a re-pricing
// reaches every suite on this harness.
const GAS_SCHEDULE   = SIM ? SIM.DEFAULT_GAS_SCHEDULE : null;
const DEFAULT_LIMITS = SIM
    ? Object.freeze({ ...SIM.DEFAULT_LIMITS, maxCpuTimeMs: E2E_MAX_CPU_TIME_MS })
    : null;

/**
 * Chain position a harness opens at: the rule set mainnet runs today. Time is the
 * newest elapsed flag day, height clears every armed height gate for (coin, network).
 * An explicit `network: null` keeps the no-network path at height 1.
 */
function resolveStart(overrides) {
    const o = overrides || {};
    const network = Object.prototype.hasOwnProperty.call(o, 'network') ? o.network : 'mainnet';
    const coin = o.coin || 'BTC';
    const height = network == null ? 1 : GATES.defaultBlockHeight(coin, network);
    return {
        network, coin,
        blockHeight:    o.blockHeight ?? height,
        blockTimestamp: o.blockTimestamp ?? GATES.liveBlockTime(undefined, network ?? undefined)
    };
}

class E2EHarness {
    /**
     * @param {Function} XChainVM - The VM constructor (passed in to allow skip if unavailable)
     * @param {object} [overrides] - Override gasCeiling or limits, or the start position
     * @param {string|null} [overrides.network='mainnet'] - null runs without a network
     * @param {string} [overrides.coin='BTC']
     * @param {number} [overrides.blockHeight] - defaults to defaultBlockHeight(coin, network)
     * @param {number} [overrides.blockTimestamp] - defaults to liveBlockTime()
     */
    constructor(XChainVM, overrides) {
        if (!SIM) throw SIM_LOAD_ERROR;
        const start = resolveStart(overrides);
        this.network = start.network;
        this.coin    = start.coin;
        this.ledger  = new MockLedger(start);
        this.indexer = new MockIndexer(this.ledger);
        this.vm = new XChainVM({
            gasSchedule: { ...GAS_SCHEDULE },
            gasCeiling:  overrides?.gasCeiling || 1000000,
            limits:      { ...DEFAULT_LIMITS, ...(overrides?.limits || {}) }
        });
        this._executionLog = [];
    }

    /**
     * Deploy a contract: validate syntax, store in ledger.
     * @param {object} opts
     * @param {string} opts.code - Contract source code
     * @param {string} opts.deployer - Deployer address
     * @param {string} opts.contractAddress - Contract address
     * @param {string[]} [opts.params] - Init params
     * @returns {object} { success, error?, gasUsed? }
     */
    async deploy(opts) {
        const { code, deployer, contractAddress, params } = opts;

        // Validate syntax
        const syntaxResult = this.vm.validateSyntax(code);
        if (!syntaxResult.valid) {
            return { success: false, error: syntaxResult.error };
        }

        // Code size check
        if (Buffer.byteLength(code, 'utf8') > (this.vm.limits.maxCodeSize || 65536)) {
            return { success: false, error: 'code size exceeds limit' };
        }

        this.ledger.deployContract(contractAddress, code, deployer, this.ledger.blockHeight);

        // Run initialize method if the contract exports one
        const initResult = await this.execute({
            contractAddress,
            method: 'initialize',
            params: params || [],
            caller: deployer
        });

        // If initialize doesn't exist (single-function export), that's fine
        if (!initResult.success && initResult.error && initResult.error.includes('unknown method')) {
            return { success: true, deployed: true, gasUsed: 0 };
        }

        return { success: initResult.success, error: initResult.error, gasUsed: initResult.gasUsed, result: initResult };
    }

    /**
     * Execute a contract method.
     * @param {object} opts
     * @param {string} opts.contractAddress
     * @param {string} opts.method
     * @param {string[]} [opts.params]
     * @param {string} opts.caller
     * @param {object} [opts.blockContext] - Override block context
     * @returns {object} Full VM result + applied ledger changes
     */
    async execute(opts) {
        const contract = this.ledger.getContract(opts.contractAddress);
        if (!contract) {
            return { success: false, error: 'contract not found', gasUsed: 0, stateChanges: [], stateDeletes: [], emittedActions: [], logs: [], returnValue: null };
        }

        const state = this.ledger.getContractState(opts.contractAddress);
        const blockContext = opts.blockContext || this.ledger.getBlockContext();

        const result = await this.vm.execute({
            code:            contract.code,
            state:           state,
            method:          opts.method || 'default',
            params:          opts.params || [],
            caller:          opts.caller,
            contractAddress: opts.contractAddress,
            blockContext:     blockContext,
            balances:        this.ledger.buildBalancesMap(),
            tokenInfo:       this.ledger.buildTokenInfoMap(),
            oracleData:      this.ledger.buildOracleAccessor(),
            crossChainData:  this.ledger.buildCrossChainAccessor(),
            pollData:        this.ledger.buildPollAccessor(),
            attestationData: this.ledger.buildAttestationAccessor(),
            ...(this.network == null ? {} : { network: this.network })
        });

        // On success, apply state changes and process emitted actions
        if (result.success) {
            this.ledger.applyStateChanges(
                opts.contractAddress,
                result.stateChanges,
                result.stateDeletes,
                blockContext.height
            );

            // Process emitted actions through mock indexer
            // If an action fails (e.g., overdraw), mark execution as failed
            try {
                this.indexer.processActions(opts.contractAddress, result.emittedActions);
            } catch (indexerError) {
                result.success = false;
                result.error = 'indexer: ' + indexerError.message;
                result.emittedActions = [];
            }
        }

        // Charge gas fee regardless of success/failure
        this.indexer.chargeGasFee(opts.caller, result.gasUsed);

        this._executionLog.push({
            contractAddress: opts.contractAddress,
            method: opts.method,
            caller: opts.caller,
            blockHeight: blockContext.height,
            success: result.success,
            gasUsed: result.gasUsed
        });

        return result;
    }

    /**
     * Deposit tokens from a user to a contract's custody.
     */
    deposit(caller, contractAddress, tick, quantity) {
        this.ledger.debitBalance(caller, tick, quantity);
        this.ledger.creditContractBalance(contractAddress, tick, quantity);
    }

    /**
     * Withdraw tokens from a contract's custody to a user.
     */
    withdraw(caller, contractAddress, tick, quantity) {
        this.ledger.debitContractBalance(contractAddress, tick, quantity);
        this.ledger.creditBalance(caller, tick, quantity);
    }

    /**
     * Advance to next block.
     */
    mineBlock() {
        this.ledger.advanceBlock();
    }

    /**
     * Seed initial balances for testing.
     */
    seedBalance(address, tick, quantity) {
        this.ledger.setBalance(address, tick, String(quantity));
    }

    /**
     * Load a contract fixture from the contracts directory.
     */
    loadContract(name) {
        return fs.readFileSync(
            path.join(__dirname, '..', 'fixtures', 'contracts', name),
            'utf8'
        );
    }

    /**
     * Get execution log for debugging.
     */
    getExecutionLog() {
        return this._executionLog;
    }

    /**
     * Reset everything for a fresh test.
     */
    reset() {
        this.ledger.reset();
        this._executionLog = [];
    }
}

module.exports = { E2EHarness, GAS_SCHEDULE, DEFAULT_LIMITS, E2E_MAX_CPU_TIME_MS };
