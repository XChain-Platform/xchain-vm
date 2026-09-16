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
 ********************************************************************/
// @ts-nocheck

module.exports = {
    // ---- read-only-state seeding -------------------------------------------

    /** Seed an address's balance of a tick (read by contract getBalance). */
    setBalance(address, tick, amount) {
        if (!this.balances[address]) this.balances[address] = {};
        this.balances[address][tick] = String(amount);
        return this;
    },

    /** Read a seeded balance (mirrors the contract's getBalance view). */
    getBalance(address, tick) {
        return (this.balances[address] && this.balances[address][tick]) || null;
    },

    /** Seed token metadata (read by contract getTokenInfo). */
    setTokenInfo(tick, info) {
        this.tokenInfo[tick] = info;
        return this;
    },

    /**
     * Seed an oracle price for a coin pair.
     * @param {string} pair
     * @param {string|number|object} price - a scalar price, or a full
     *        { price, roundNumber, timestamp } record.
     */
    setPrice(pair, price) {
        const rec = (price && typeof price === 'object')
            ? {
                price: String(price.price),
                roundNumber: price.roundNumber != null ? Number(price.roundNumber) : 0,
                timestamp: price.timestamp != null ? Number(price.timestamp) : this.block.timestamp
              }
            : { price: String(price), roundNumber: 0, timestamp: this.block.timestamp };
        this.oracle.prices[pair] = rec;
        if (!this.oracle.rounds[pair]) this.oracle.rounds[pair] = {};
        this.oracle.rounds[pair][String(rec.roundNumber)] = rec;
        return this;
    },

    /** Set the oracle snapshot age (seconds) reported by getSnapshotAge(). */
    setOracleSnapshotAge(seconds) {
        this.oracle.snapshotAge = Number(seconds);
        return this;
    },

    /**
     * Seed a settled ATTEST response (read by attestation.getResponse in a
     * callback method). Keys are request_ids; the simulator does not derive
     * them, so pass the id your callback will be handed.
     */
    setAttestationResponse(requestId, value) {
        this.attestationData.responses[String(requestId)] = value;
        return this;
    },

    /**
     * Seed a finalized VOTE poll result (read by poll.getPollResult).
     * @param {number|string} pollIndex - the VOTE v0 action_index
     * @param {object} result - { status, winning_option, total_weight,
     *        total_voters, decided_early, options:[{index,weight,voters}] }
     */
    setPollResult(pollIndex, result) {
        this.pollData.polls[String(pollIndex)] = result;
        return this;
    },

    /**
     * Seed one staker's stake on THIS contract, keeping the three derived
     * views the accessor reads in agreement. `stakersByTick` is what
     * stake.getStakers returns verbatim, so it is kept sorted by descending
     * amount here the way the indexer pre-sorts it.
     * @param {string} pubkey
     * @param {string} tick
     * @param {string|number} amount
     */
    setStake(pubkey, tick, amount) {
        const pk = String(pubkey || '').toLowerCase();
        const tk = String(tick || '');
        const amt = String(amount);
        const key = pk + '|' + tk;
        const prev = this.contractStakeData.stakeByPubkeyTick[key];
        this.contractStakeData.stakeByPubkeyTick[key] = amt;

        const list = (this.contractStakeData.stakersByTick[tk] || []).filter((s) => s.pubkey !== pk);
        if (Number(amt) !== 0) list.push({ pubkey: pk, amount: amt });
        list.sort((a, b) => (Number(b.amount) - Number(a.amount)) || (a.pubkey < b.pubkey ? -1 : 1));
        this.contractStakeData.stakersByTick[tk] = list;

        // Recomputed from the roster rather than accumulated, so re-seeding the
        // same pubkey replaces its stake instead of double-counting it (prev is
        // read only to make that intent explicit at the call site).
        void prev;
        this.contractStakeData.totalByTick[tk] =
            String(list.reduce((sum, s) => sum + Number(s.amount), 0));
        return this;
    },

    /** Seed a cross-chain attestation value (read by crosschain.getAttestation). */
    setCrossChainAttestation(chain, actionIndex, value) {
        this.crossChainData.attestations[String(chain) + ':' + String(actionIndex)] = value;
        return this;
    },

    /** Mark a cross-chain action settled (read by crosschain.isSettled). */
    setCrossChainSettled(chain, actionIndex, settled = true) {
        this.crossChainData.settled[String(chain) + ':' + String(actionIndex)] = settled === true;
        return this;
    },

    /**
     * Seed the terminal outcome of a cross-chain call this chain originated
     * (read by crosschain.getCallResult). Keys are lower-cased call_ids,
     * matching the accessor's own lookup.
     */
    setCallResult(callId, result) {
        this.crossChainData.calls[String(callId).toLowerCase()] =
            { status: String(result && result.status), payload: String(result && result.payload) };
        return this;
    }
};
