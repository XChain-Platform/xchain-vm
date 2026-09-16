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
 * XChain VM: Read-only data accessors
 *
 * The gateway (src/gateway.js) calls oracle / crossChain / attestation /
 * contract-stake accessors SYNCHRONOUSLY through the isolate's applySync
 * bridge. Historically the host passed accessor OBJECTS (closures) in
 * execute() opts. Closures cannot cross an IPC boundary, which blocks
 * out-of-process execution (the fix for the host-abort liveness bug).
 *
 * This module standardizes the contract: the host passes a plain,
 * SERIALIZABLE snapshot, and these builders turn it into the synchronous
 * accessor object the gateway expects. `resolveAccessors()` is
 * backward-compatible: if a field is already an accessor object (has the
 * expected methods), it is passed through unchanged, so existing in-process
 * callers/tests keep working without migration.
 *
 * Snapshot shapes (all plain JSON):
 *   oracle:        { snapshotAge:Number, prices:{ [pair]:{price,roundNumber,timestamp} },
 *                    rounds:{ [pair]:{ [round]:{price,roundNumber,timestamp} } },
 *                    roundFloor:Number }   // oldest round `rounds` guarantees, 0 = all of it
 *   contractStake: { stakeByPubkeyTick:{ ["pubkey|tick"]:amountStr },
 *                    totalByTick:{ [tick]:amountStr },
 *                    stakersByTick:{ [tick]:[{pubkey,amount}] } }   // pre-sorted, pre-capped
 *   crossChain:    { attestations:{ ["chain:index"]:value }, settled:{ ["chain:index"]:true } }
 *   attestation:   { responses:{ [requestId]:value } }
 ********************************************************************/
// @ts-nocheck

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// A value is a "legacy accessor object" (not a snapshot) if it already
// exposes the method named `probe`. Snapshots are plain data and never do.
function isAccessor(obj, probe) {
    return obj && typeof obj[probe] === 'function';
}

function buildOracleAccessor(snap) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getPrice')) return snap; // legacy passthrough
    const prices = snap.prices || {};
    const rounds = snap.rounds || {};
    const age = (snap.snapshotAge != null) ? snap.snapshotAge : MAX_SAFE;
    // Oldest round the host's preload GUARANTEES. The host ships a bounded window
    // of oracle history, so "not in the snapshot" carries two very different
    // meanings that must not collapse into one null: a round below this floor was
    // evicted and may well have been published, while a round at or above it
    // genuinely never existed. Contracts vote on that distinction. The price-bet
    // family voids a bet when its settle round reads null, so without the floor
    // the loser of a bet consensus already settled could reclaim their stake by
    // waiting for the round to scroll out of the window. 0 (or absent, for a host
    // that predates the field) means nothing is hidden.
    const roundFloor = Number(snap.roundFloor) > 0 ? Number(snap.roundFloor) : 0;
    return {
        getPrice: (coinPair) => (prices[coinPair] != null ? prices[coinPair] : null),
        getPriceAtRound: (coinPair, roundNumber) => {
            const byRound = rounds[coinPair];
            const r = byRound ? byRound[String(roundNumber)] : undefined;
            if (r != null) return r;
            // Below the floor the honest answer is "cannot know", including for a
            // pair the snapshot carries nothing for: the pair's rows for that round
            // were evicted with everyone else's. Shaped like a price row with the
            // price withheld, the same shape a stale tip already uses, so a contract
            // reading `.price` gets null rather than a type it cannot handle.
            const n = Number(roundNumber);
            if (roundFloor > 0 && Number.isFinite(n) && n < roundFloor)
                return { price: null, roundNumber: n, timestamp: 0, outsideWindow: true };
            return null;
        },
        getSnapshotAge: () => age
    };
}

function buildContractStakeAccessor(snap) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getStake')) return snap; // legacy passthrough
    const stakeByPubkeyTick = snap.stakeByPubkeyTick || {};
    const totalByTick       = snap.totalByTick || {};
    const stakersByTick      = snap.stakersByTick || {};
    return {
        getStake: (pubkey, token) => {
            const key = String(pubkey || '').toLowerCase() + '|' + String(token || '');
            return stakeByPubkeyTick[key] || '0';
        },
        getTotalStaked: (token) => totalByTick[String(token || '')] || '0',
        getStakers: (token) => {
            const arr = stakersByTick[String(token || '')];
            return Array.isArray(arr) ? arr : [];
        }
    };
}

function buildCrossChainAccessor(snap) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getAttestation')) return snap; // legacy passthrough
    const attestations = snap.attestations || {};
    const settled      = snap.settled || {};
    const calls        = snap.calls || {};
    return {
        getAttestation: (chain, actionIndex) => {
            const k = String(chain) + ':' + String(actionIndex);
            return attestations[k] != null ? attestations[k] : null;
        },
        isSettled: (chain, actionIndex) => {
            const k = String(chain) + ':' + String(actionIndex);
            return settled[k] === true;
        },
        // Terminal outcome of a cross-chain call this chain originated:
        // { status, payload } or null while in flight (keys are call_ids).
        getCallResult: (callId) => {
            const r = calls[String(callId).toLowerCase()];
            return r != null ? { status: String(r.status), payload: String(r.payload) } : null;
        }
    };
}

function buildAttestationAccessor(snap) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getResponse')) return snap; // legacy passthrough
    const responses = snap.responses || {};
    return {
        getResponse: (requestId) => {
            if (typeof requestId !== 'string') return null;
            return responses[requestId] != null ? responses[requestId] : null;
        }
    };
}

function buildPollAccessor(snap) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getPollResult')) return snap; // legacy passthrough
    const polls = snap.polls || {};
    return {
        // Frozen result of a finalized VOTE poll, or null if the poll does not
        // exist or has not finalized yet. Keys are poll indices (the VOTE v0
        // action_index). Shape: { status, winning_option, total_weight,
        // total_voters, decided_early, options:[{index,weight,voters}] }.
        getPollResult: (pollIndex) => {
            const p = polls[String(pollIndex)];
            return p != null ? p : null;
        }
    };
}

/**
 * Resolve all four read-only-data fields from execute() opts into synchronous
 * accessor objects, accepting either plain snapshots or legacy accessor objects.
 * @param {object} opts - execute() options
 * @returns {{oracleData, crossChainData, attestationData, contractStakeData}}
 */
function resolveAccessors(opts) {
    return {
        oracleData:        buildOracleAccessor(opts.oracleData),
        crossChainData:    buildCrossChainAccessor(opts.crossChainData),
        attestationData:   buildAttestationAccessor(opts.attestationData),
        contractStakeData: buildContractStakeAccessor(opts.contractStakeData),
        pollData:          buildPollAccessor(opts.pollData)
    };
}

module.exports = {
    buildOracleAccessor,
    buildContractStakeAccessor,
    buildCrossChainAccessor,
    buildAttestationAccessor,
    buildPollAccessor,
    resolveAccessors
};
