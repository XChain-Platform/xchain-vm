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
 * MockLedger — In-memory ledger for E2E testing
 *
 * Simulates the indexer database tables:
 *   - balances:          address/tick → quantity (string)
 *   - contracts:         contractAddress → { code, deployer, blockIndex }
 *   - contractState:     contractAddress → { key: value }
 *   - contractBalances:  contractAddress/tick → quantity (string)
 *   - stateHistory:      contractAddress → [{ key, value, blockIndex }]
 *   - oraclePrices:      coinPair → { current, rounds: { N: price } }
 *   - crossChainData:    "chain:actionIndex" → attestation
 ********************************************************************/
// @ts-nocheck

// 


const { create, all } = require('mathjs');
const math = create(all, { number: 'BigNumber', precision: 64 });

class MockLedger {
    constructor() {
        this.balances         = {};  // { address: { tick: quantityStr } }
        this.contracts        = {};  // { contractAddress: { code, deployer, blockIndex } }
        this.contractState    = {};  // { contractAddress: { key: value } }
        this.contractBalances = {};  // { contractAddress: { tick: quantityStr } }
        this.stateHistory     = {};  // { contractAddress: [{ key, value, blockIndex, deleted }] }
        this.oraclePrices     = {};  // { coinPair: { current: priceStr, rounds: {}, snapshotAge: N } }
        this.crossChain       = {};  // { "chain:idx": attestation }
        this.blockHeight      = 1;
        this.blockTimestamp    = 1700000000;
        this.blockHash        = 'e2e_block_hash_1';
        this.gasPrice         = '1';  // 1 XCHAIN per unit gas (simplified)
        this.gasAddress       = 'GAS_ADDRESS';
        this.gasToken         = 'XCHAIN';
    }

    // --- Balance helpers ---

    getBalance(address, tick) {
        return this.balances[address]?.[tick] || null;
    }

    setBalance(address, tick, quantity) {
        if (!this.balances[address]) this.balances[address] = {};
        this.balances[address][tick] = String(quantity);
    }

    creditBalance(address, tick, amount) {
        const current = this.getBalance(address, tick) || '0';
        this.setBalance(address, tick, math.format(math.add(math.bignumber(current), math.bignumber(amount)), { notation: 'fixed' }));
    }

    debitBalance(address, tick, amount) {
        const current = this.getBalance(address, tick) || '0';
        const result = math.subtract(math.bignumber(current), math.bignumber(amount));
        if (math.smaller(result, math.bignumber('0')))
            throw new Error(`insufficient balance: ${address} has ${current} ${tick}, tried to debit ${amount}`);
        this.setBalance(address, tick, math.format(result, { notation: 'fixed' }));
    }

    // --- Contract helpers ---

    deployContract(contractAddress, code, deployer, blockIndex) {
        this.contracts[contractAddress] = { code, deployer, blockIndex };
        this.contractState[contractAddress] = {};
        this.contractBalances[contractAddress] = {};
        this.stateHistory[contractAddress] = [];
    }

    getContract(contractAddress) {
        return this.contracts[contractAddress] || null;
    }

    // --- Contract state helpers ---

    getContractState(contractAddress) {
        return { ...(this.contractState[contractAddress] || {}) };
    }

    getContractStateKey(contractAddress, key) {
        return this.contractState[contractAddress]?.[key] ?? null;
    }

    applyStateChanges(contractAddress, changes, deletes, blockIndex) {
        if (!this.contractState[contractAddress]) this.contractState[contractAddress] = {};
        if (!this.stateHistory[contractAddress]) this.stateHistory[contractAddress] = [];

        for (const { key, value } of changes) {
            this.contractState[contractAddress][key] = value;
            this.stateHistory[contractAddress].push({ key, value, blockIndex, deleted: false });
        }
        for (const key of deletes) {
            delete this.contractState[contractAddress][key];
            this.stateHistory[contractAddress].push({ key, value: null, blockIndex, deleted: true });
        }
    }

    // --- Contract balance helpers ---

    getContractBalance(contractAddress, tick) {
        return this.contractBalances[contractAddress]?.[tick] || null;
    }

    creditContractBalance(contractAddress, tick, amount) {
        if (!this.contractBalances[contractAddress]) this.contractBalances[contractAddress] = {};
        const current = this.contractBalances[contractAddress][tick] || '0';
        this.contractBalances[contractAddress][tick] = math.format(
            math.add(math.bignumber(current), math.bignumber(amount)), { notation: 'fixed' }
        );
    }

    debitContractBalance(contractAddress, tick, amount) {
        const current = this.getContractBalance(contractAddress, tick) || '0';
        const result = math.subtract(math.bignumber(current), math.bignumber(amount));
        if (math.smaller(result, math.bignumber('0')))
            throw new Error(`insufficient contract balance: ${contractAddress} has ${current} ${tick}, tried to debit ${amount}`);
        this.contractBalances[contractAddress][tick] = math.format(result, { notation: 'fixed' });
    }

    // --- Oracle helpers ---

    seedOracle(coinPair, currentPrice, snapshotAge, rounds) {
        this.oraclePrices[coinPair] = {
            current: String(currentPrice),
            snapshotAge: snapshotAge || 0,
            rounds: rounds || {}
        };
    }

    buildOracleAccessor() {
        const self = this;
        return {
            getPrice: (coinPair) => self.oraclePrices[coinPair]?.current || null,
            getPriceAtRound: (coinPair, round) => self.oraclePrices[coinPair]?.rounds?.[round] || null,
            getSnapshotAge: () => {
                // Return the max snapshot age across all pairs (simplified)
                let maxAge = 0;
                for (const pair in self.oraclePrices) {
                    if (self.oraclePrices[pair].snapshotAge > maxAge)
                        maxAge = self.oraclePrices[pair].snapshotAge;
                }
                return maxAge;
            }
        };
    }

    // --- Cross-chain helpers ---

    seedCrossChain(chain, actionIndex, attestation) {
        this.crossChain[chain + ':' + actionIndex] = attestation;
    }

    buildCrossChainAccessor() {
        const self = this;
        return {
            getAttestation: (chain, actionIndex) => self.crossChain[chain + ':' + actionIndex] || null,
            isSettled: (chain, actionIndex) => {
                const att = self.crossChain[chain + ':' + actionIndex];
                return att ? att.settled === true : false;
            }
        };
    }

    // --- Block simulation ---

    advanceBlock() {
        this.blockHeight++;
        this.blockTimestamp += 600; // ~10 min per block
        this.blockHash = 'e2e_block_hash_' + this.blockHeight;
    }

    getBlockContext() {
        return {
            height: this.blockHeight,
            timestamp: this.blockTimestamp,
            hash: this.blockHash
        };
    }

    // --- Rollback (reorg simulation) ---

    rollbackToBlock(targetBlock) {
        for (const addr in this.stateHistory) {
            // Remove history entries at or after targetBlock
            this.stateHistory[addr] = this.stateHistory[addr].filter(e => e.blockIndex < targetBlock);
            // Rebuild state from remaining history
            this.contractState[addr] = {};
            for (const entry of this.stateHistory[addr]) {
                if (entry.deleted) {
                    delete this.contractState[addr][entry.key];
                } else {
                    this.contractState[addr][entry.key] = entry.value;
                }
            }
        }
        // Remove contracts deployed at or after targetBlock
        for (const addr in this.contracts) {
            if (this.contracts[addr].blockIndex >= targetBlock) {
                delete this.contracts[addr];
                delete this.contractState[addr];
                delete this.contractBalances[addr];
                delete this.stateHistory[addr];
            }
        }
        this.blockHeight = targetBlock - 1;
        this.blockHash = 'e2e_block_hash_' + this.blockHeight;
    }

    // --- Build balances map for VM execute ---

    buildBalancesMap() {
        // Merge user balances and contract balances into the format the VM expects
        const result = {};
        for (const addr in this.balances) {
            result[addr] = { ...this.balances[addr] };
        }
        for (const addr in this.contractBalances) {
            result[addr] = { ...this.contractBalances[addr] };
        }
        return result;
    }

    // --- Reset ---

    reset() {
        this.balances = {};
        this.contracts = {};
        this.contractState = {};
        this.contractBalances = {};
        this.stateHistory = {};
        this.oraclePrices = {};
        this.crossChain = {};
        this.blockHeight = 1;
        this.blockTimestamp = 1700000000;
        this.blockHash = 'e2e_block_hash_1';
    }
}

module.exports = MockLedger;
