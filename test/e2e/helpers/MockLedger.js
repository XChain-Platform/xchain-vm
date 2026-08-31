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
 * MockLedger: In-memory ledger for E2E testing
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

const { create, all } = require('mathjs');
const math = create(all, { number: 'BigNumber', precision: 64 });

// The PRODUCTION oracle accessor builder. The mock feeds it a snapshot in the
// host's shape rather than hand-rolling the read semantics, so a contract under
// test meets the accessor the indexer's preload actually produces - including its
// answer for a round that has scrolled out of the preloaded window.
const { buildOracleAccessor } = require('../../../src/readonly-accessors.js');

class MockLedger {
    constructor() {
        this.balances         = {};  // { address: { tick: quantityStr } }
        this.contracts        = {};  // { contractAddress: { code, deployer, blockIndex } }
        this.contractState    = {};  // { contractAddress: { key: value } }
        this.contractBalances = {};  // { contractAddress: { tick: quantityStr } }
        this.tokenDecimals    = {};  // { tick: decimalsInt } (registered ticks only)
        this.stateHistory     = {};  // { contractAddress: [{ key, value, blockIndex, deleted }] }
        this.oracleRoundFloor = 0;   // oldest round the host's preload guarantees (0 = all history)
        this.oraclePrices     = {};  // { coinPair: { current: {price,roundNumber,timestamp}, rounds: {}, snapshotAge: N } }
        this.crossChain       = {};  // { "chain:idx": attestation }
        this.pollResults      = {};  // { pollIndex: frozen VOTE poll result }
        this.attestations     = {};  // { requestId: { status, payload, providerId, blockIndex, validatorCount } }
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

    // --- Token metadata (decimals) ---
    //
    // The real indexer knows every issued tick's decimal precision and (a) exposes
    // it to contracts via xchain.getTokenInfo and (b) normalizes emitted amounts to
    // it at write time. Tests opt in per tick with setTokenDecimals; unregistered
    // ticks behave exactly as before (no tokenInfo entry, no emission normalization),
    // so suites that never call this are unaffected.

    setTokenDecimals(tick, decimals) {
        this.tokenDecimals[tick] = parseInt(decimals, 10);
    }

    getTokenDecimals(tick) {
        return this.tokenDecimals[tick];
    }

    // The tokenInfo snapshot the VM gateway hands to xchain.getTokenInfo(tick).
    // Mirrors the indexer's shape (uppercase keys, integer DECIMALS).
    buildTokenInfoMap() {
        const out = {};
        for (const tick in this.tokenDecimals) {
            out[tick] = { TICK: tick, DECIMALS: this.tokenDecimals[tick] };
        }
        return out;
    }

    // Normalize an emitted amount to a tick's decimals the way the real indexer does
    // at ledger write time (util.bcadd(amount,0,decimals) -> mathjs.format).
    //
    // That rounding is HALF-UP (away from zero), not half-even. Measured, not
    // assumed: at 8 decimals '0.000000015' -> '0.00000002' and '0.000000025' ->
    // '0.00000003' (half-even would give '0.00000002' for the second), and at 0
    // decimals '2.5' -> '3', '3.5' -> '4', '-2.5' -> '-3'. The distinction is
    // consensus-relevant, so it is stated here rather than inferred: contracts
    // that quantise before emitting (floorToDecimals in amm / crowdsale /
    // treasury / stableVault / priceBet) do so precisely because this re-round
    // can push a half-unit-off amount UP past a supply cap or past custody.
    //
    // Returns the amount unchanged when the tick's decimals are unregistered.
    normalizeToTick(tick, amount) {
        const d = this.tokenDecimals[tick];
        if (d === undefined) return String(amount);
        return math.format(math.bignumber(amount), { notation: 'fixed', precision: d });
    }

    // --- Oracle helpers ---

    // `currentPrice` should be a { price, roundNumber, timestamp } object (the
    // shape the indexer's getOracleDataForVM feeds through readonly-accessors).
    // A bare string/number is kept as a string for legacy tests, but contracts
    // written against the production accessor expect the object.
    seedOracle(coinPair, currentPrice, snapshotAge, rounds) {
        this.oraclePrices[coinPair] = {
            current: (currentPrice !== null && typeof currentPrice === 'object')
                ? currentPrice : String(currentPrice),
            snapshotAge: snapshotAge || 0,
            rounds: rounds || {}
        };
    }

    /**
     * Oldest round the host's preload would guarantee. 0 (the default) means all
     * history is loaded; a positive value makes every round below it read as
     * "outside the loaded window" rather than as a round that never existed.
     */
    seedOracleRoundFloor(roundFloor) {
        this.oracleRoundFloor = Number(roundFloor) || 0;
    }

    buildOracleAccessor() {
        const self = this;
        const snap = { prices: {}, rounds: {}, roundFloor: self.oracleRoundFloor || 0 };
        for (const pair in self.oraclePrices) {
            snap.prices[pair] = self.oraclePrices[pair].current;
            snap.rounds[pair] = self.oraclePrices[pair].rounds || {};
        }
        const real = buildOracleAccessor(snap);
        return {
            getPrice: real.getPrice,
            getPriceAtRound: real.getPriceAtRound,
            // Kept local: the mock reports the max age across pairs, where the host
            // ships a single per-snapshot age.
            getSnapshotAge: () => {
                // Simplified: max snapshot age across all pairs, not per-pair.
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

    // --- Attestation helpers (ATTEST / xchain.attestation.getResponse) ---

    // Seed a settled attestation response, keyed by the deterministic
    // request_id xchain.attestation.request() returns. Mirrors the shape the
    // indexer feeds through readOnlyData.attestationData in production.
    seedAttestation(requestId, response) {
        this.attestations[requestId] = response;
    }

    buildAttestationAccessor() {
        const self = this;
        return {
            getResponse: (requestId) => self.attestations[requestId] || null
        };
    }

    // --- Poll helpers (VOTE governance) ---

    // Seed a finalized poll readable via xchain.getPollResult. `result` mirrors
    // the indexer's getPollResultsForVM map entries: { status, winning_option,
    // total_weight, total_voters, decided_early, options:[{index,weight,voters}] }.
    seedPollResult(pollIndex, result) {
        this.pollResults[String(pollIndex)] = result;
    }

    buildPollAccessor() {
        const self = this;
        return {
            getPollResult: (pollIndex) => self.pollResults[String(pollIndex)] || null
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
            this.stateHistory[addr] = this.stateHistory[addr].filter(e => e.blockIndex < targetBlock);
            this.contractState[addr] = {};
            for (const entry of this.stateHistory[addr]) {
                if (entry.deleted) {
                    delete this.contractState[addr][entry.key];
                } else {
                    this.contractState[addr][entry.key] = entry.value;
                }
            }
        }
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
        this.tokenDecimals = {};
        this.stateHistory = {};
        this.oraclePrices = {};
        this.oracleRoundFloor = 0;
        this.crossChain = {};
        this.pollResults = {};
        this.blockHeight = 1;
        this.blockTimestamp = 1700000000;
        this.blockHash = 'e2e_block_hash_1';
    }
}

module.exports = MockLedger;
