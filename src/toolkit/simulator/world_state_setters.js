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

const { bignumber } = require('mathjs');

// The indexer snapshot's cap on the getStakers roster per tick; the total still counts every staker.
const MAX_STAKERS_PER_TICK = 1000;

// Parse a seeded stake exactly, naming the argument when it is not a decimal amount.
function stakeAmount(amount) {
    try {
        return bignumber(String(amount));
    } catch (e) {
        throw new Error('setStake: amount must be a decimal number, got ' + JSON.stringify(String(amount)));
    }
}

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
     * Set the oldest oracle round this simulated host guarantees. 0 (the default)
     * hides no history. A positive floor is the bounded window a node ships: an
     * unseeded round below it reads back from oracle.getPriceAtRound as
     * { price: null, outsideWindow: true } rather than as plain null.
     */
    setOracleRoundFloor(roundFloor) {
        const n = Number(roundFloor);
        this.oracle.roundFloor = (Number.isFinite(n) && n > 0) ? n : 0;
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
     *        total_voters, decided_early, options:[{index,weight,voters}],
     *        tick? } (tick: the electorate token, present once the host
     *        enables VOTE_POLL_TICK_VISIBLE)
     */
    setPollResult(pollIndex, result) {
        this.pollData.polls[String(pollIndex)] = result;
        return this;
    },

    /**
     * Seed one staker's stake on THIS contract, keeping the three derived
     * views the accessor reads in agreement. Mirrors the indexer snapshot
     * with exact BigNumber arithmetic: `stakersByTick` (what getStakers
     * returns verbatim) is sorted by descending amount with an ascending
     * pubkey tiebreak and capped at 1000, and `totalByTick` sums every
     * staker. Re-seeding a pubkey replaces its stake; a zero stake removes
     * it. Amounts are taken as given, so seed them at the token's precision.
     * @param {string} pubkey
     * @param {string} tick
     * @param {string|number} amount
     */
    setStake(pubkey, tick, amount) {
        const pk = String(pubkey || '').toLowerCase();
        const tk = String(tick || '');
        stakeAmount(amount);
        this.contractStakeData.stakeByPubkeyTick[pk + '|' + tk] = String(amount);

        // Rebuild from every seeded stake on the tick, so the cap never loses a staker.
        const roster = [];
        for (const [key, amt] of Object.entries(this.contractStakeData.stakeByPubkeyTick)) {
            const bar = key.indexOf('|');
            if (key.slice(bar + 1) !== tk) continue;
            const big = stakeAmount(amt);
            if (!big.isZero()) roster.push({ pubkey: key.slice(0, bar), amount: amt, big });
        }
        roster.sort((a, b) => (b.big.gt(a.big) ? 1 : a.big.gt(b.big) ? -1
            : a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
        this.contractStakeData.stakersByTick[tk] = roster.slice(0, MAX_STAKERS_PER_TICK)
            .map((s) => ({ pubkey: s.pubkey, amount: s.amount }));
        this.contractStakeData.totalByTick[tk] =
            roster.reduce((sum, s) => sum.plus(s.big), bignumber(0)).toString();
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
