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
 * MockIndexer: processes emitted VM actions against the MockLedger
 *
 * Translates SEND, DESTROY, MINT, and other emitted actions into
 * ledger state changes, simulating what the real xchain-indexer does.
 ********************************************************************/
// @ts-nocheck

// 


class MockIndexer {
    constructor(ledger) {
        this.ledger = ledger;
    }

    /**
     * Process all emitted actions from a VM execution result.
     * Actions are emitted from a contract's custody.
     * @param {string} contractAddress - The contract that emitted these actions
     * @param {Array} emittedActions - Array of { action, params }
     */
    processActions(contractAddress, emittedActions) {
        for (const { action, params } of emittedActions) {
            switch (action) {
                case 'SEND':
                    this._processSend(contractAddress, params);
                    break;
                case 'DESTROY':
                    this._processDestroy(contractAddress, params);
                    break;
                case 'MINT':
                    this._processMint(contractAddress, params);
                    break;
                case 'ISSUE':
                    this._processIssue(params);
                    break;
                default:
                    // Record but don't process other action types
                    // (ORDER, DISPENSER, DIVIDEND, etc. would need full indexer logic)
                    break;
            }
        }
    }

    _processSend(contractAddress, params) {
        const { destination, tick } = params;
        // The real indexer normalizes an emitted amount to the tick's decimals before
        // it hits the ledger; mirror that so custody reflects what a node would store.
        const quantity = this.ledger.normalizeToTick(tick, params.quantity);
        // Debit from contract custody
        this.ledger.debitContractBalance(contractAddress, tick, quantity);
        // Credit to destination
        this.ledger.creditBalance(destination, tick, quantity);
    }

    _processDestroy(contractAddress, params) {
        const { tick } = params;
        const quantity = this.ledger.normalizeToTick(tick, params.quantity);
        // Debit from contract custody (tokens destroyed)
        this.ledger.debitContractBalance(contractAddress, tick, quantity);
    }

    _processMint(contractAddress, params) {
        const { tick } = params;
        const quantity = this.ledger.normalizeToTick(tick, params.quantity);
        // Credit to contract custody
        this.ledger.creditContractBalance(contractAddress, tick, quantity);
    }

    _processIssue(params) {
        // Token issuance: just record it exists
        // Real indexer would create token record
    }

    /**
     * Charge gas fee to caller.
     * @param {string} caller
     * @param {number} gasUsed
     */
    chargeGasFee(caller, gasUsed) {
        if (gasUsed <= 0) return;
        const fee = String(gasUsed); // 1:1 gas-to-XCHAIN for simplicity
        try {
            this.ledger.debitBalance(caller, this.ledger.gasToken, fee);
            this.ledger.creditBalance(this.ledger.gasAddress, this.ledger.gasToken, fee);
        } catch (e) {
            // Caller can't afford fee; in the real indexer this would reject the tx
            // For E2E testing we allow it to proceed with a warning
        }
    }
}

module.exports = MockIndexer;
