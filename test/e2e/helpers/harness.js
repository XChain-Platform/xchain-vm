/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E Test Harness — Orchestrates deploy/execute cycles
 *
 * Wraps the real XChainVM with a MockLedger and MockIndexer to
 * simulate the full platform pipeline.
 ********************************************************************/
// @ts-nocheck

// 


const fs   = require('fs');
const path = require('path');
const MockLedger  = require('./MockLedger.js');
const MockIndexer = require('./MockIndexer.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION:    1,
    VM_STATE_READ:     100,
    VM_STATE_WRITE:    200,
    VM_STATE_DELETE:   100,
    VM_ORACLE_READ:    100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000,
    VM_EMISSION:       500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

const DEFAULT_LIMITS = {
    maxCpuTimeMs:      5000,
    maxMemory:         8,
    maxEmissions:      50,
    maxStateKeys:      10000,
    maxStateValueSize: 65536,
    maxCodeSize:       65536
};

class E2EHarness {
    /**
     * @param {Function} XChainVM - The VM constructor (passed in to allow skip if unavailable)
     * @param {object} [overrides] - Override gasCeiling or limits
     */
    constructor(XChainVM, overrides) {
        this.ledger  = new MockLedger();
        this.indexer = new MockIndexer(this.ledger);
        this.vm = new XChainVM({
            gasSchedule: GAS_SCHEDULE,
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

        // Store contract
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
            tokenInfo:       {},
            oracleData:      this.ledger.buildOracleAccessor(),
            crossChainData:  this.ledger.buildCrossChainAccessor()
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

        // Log execution
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
            path.join(__dirname, '..', 'contracts', name),
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

module.exports = { E2EHarness, GAS_SCHEDULE, DEFAULT_LIMITS };
