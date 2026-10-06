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

// Readonly accessor own-key lookups: from the gate on, a snapshot key that names an
// inherited member ('constructor', '__proto__') resolves as absent. Mainnet stays
// unarmed (null) so history replays unchanged; unknown networks resolve like mainnet.
const ACCESSOR_OWN_KEY_ACTIVATION = Object.freeze({
    mainnet: null,
    testnet: 0,
    regtest: 0,
});
function isAccessorOwnKeyActive(network, blockTime) {
    const gate = ACCESSOR_OWN_KEY_ACTIVATION[Object.prototype.hasOwnProperty.call(ACCESSOR_OWN_KEY_ACTIVATION, network) ? network : 'mainnet'];
    if (!Number.isFinite(gate)) return false;
    if (gate === 0) return true;
    const t = Number(blockTime);
    return Number.isFinite(t) && t >= gate;
}

// A value is a "legacy accessor object" (not a snapshot) if it already
// exposes the method named `probe`. Snapshots are plain data and never do.
function isAccessor(obj, probe) {
    return obj && typeof obj[probe] === 'function';
}

// Own-key read used once the consensus gate is armed: a pair, round or id such as
// 'constructor' or '__proto__' names an inherited member, never a snapshot entry.
// Below the gate the plain index read is kept so replay stays byte-identical.
function lookup(map, key, ownKeys) {
    if (!ownKeys) return map[key];
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function buildOracleAccessor(snap, ownKeys = false) {
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
        getPrice: (coinPair) => {
            const p = lookup(prices, coinPair, ownKeys);
            return p != null ? p : null;
        },
        getPriceAtRound: (coinPair, roundNumber) => {
            const byRound = lookup(rounds, coinPair, ownKeys);
            const r = byRound ? lookup(byRound, String(roundNumber), ownKeys) : undefined;
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

function buildContractStakeAccessor(snap, ownKeys = false) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getStake')) return snap; // legacy passthrough
    const stakeByPubkeyTick = snap.stakeByPubkeyTick || {};
    const totalByTick       = snap.totalByTick || {};
    const stakersByTick      = snap.stakersByTick || {};
    return {
        getStake: (pubkey, token) => {
            const key = String(pubkey || '').toLowerCase() + '|' + String(token || '');
            return lookup(stakeByPubkeyTick, key, ownKeys) || '0';
        },
        getTotalStaked: (token) => lookup(totalByTick, String(token || ''), ownKeys) || '0',
        getStakers: (token) => {
            const arr = lookup(stakersByTick, String(token || ''), ownKeys);
            return Array.isArray(arr) ? arr : [];
        }
    };
}

function buildCrossChainAccessor(snap, ownKeys = false) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getAttestation')) return snap; // legacy passthrough
    const attestations = snap.attestations || {};
    const settled      = snap.settled || {};
    const calls        = snap.calls || {};
    return {
        getAttestation: (chain, actionIndex) => {
            const k = String(chain) + ':' + String(actionIndex);
            const v = lookup(attestations, k, ownKeys);
            return v != null ? v : null;
        },
        isSettled: (chain, actionIndex) => {
            const k = String(chain) + ':' + String(actionIndex);
            return lookup(settled, k, ownKeys) === true;
        },
        // Terminal outcome of a cross-chain call this chain originated:
        // { status, payload } or null while in flight (keys are call_ids).
        getCallResult: (callId) => {
            const r = lookup(calls, String(callId).toLowerCase(), ownKeys);
            return r != null ? { status: String(r.status), payload: String(r.payload) } : null;
        }
    };
}

function buildAttestationAccessor(snap, ownKeys = false) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getResponse')) return snap; // legacy passthrough
    const responses = snap.responses || {};
    return {
        getResponse: (requestId) => {
            if (typeof requestId !== 'string') return null;
            const v = lookup(responses, requestId, ownKeys);
            return v != null ? v : null;
        }
    };
}

function buildPollAccessor(snap, ownKeys = false) {
    if (snap == null) return null;
    if (isAccessor(snap, 'getPollResult')) return snap; // legacy passthrough
    const polls = snap.polls || {};
    return {
        // Frozen result of a finalized VOTE poll, or null if the poll does not
        // exist or has not finalized yet. Keys are poll indices (the VOTE v0
        // action_index). Shape: { status, winning_option, total_weight,
        // total_voters, decided_early, options:[{index,weight,voters}], tick? },
        // where `tick` is present only once VOTE_POLL_TICK_VISIBLE is enabled.
        // Return the host entry verbatim: never project or whitelist its fields
        // (dropping a flag-gated field makes an electorate-pinned contract revert).
        getPollResult: (pollIndex) => {
            const p = lookup(polls, String(pollIndex), ownKeys);
            return p != null ? p : null;
        }
    };
}

/**
 * Resolve all four read-only-data fields from execute() opts into synchronous
 * accessor objects, accepting either plain snapshots or legacy accessor objects.
 * @param {object} opts - execute() options
 * @param {boolean} [ownKeys] - resolve snapshot keys as own properties only (consensus-gated)
 * @returns {{oracleData, crossChainData, attestationData, contractStakeData}}
 */
function resolveAccessors(opts, ownKeys = false) {
    return {
        oracleData:        buildOracleAccessor(opts.oracleData, ownKeys),
        crossChainData:    buildCrossChainAccessor(opts.crossChainData, ownKeys),
        attestationData:   buildAttestationAccessor(opts.attestationData, ownKeys),
        contractStakeData: buildContractStakeAccessor(opts.contractStakeData, ownKeys),
        pollData:          buildPollAccessor(opts.pollData, ownKeys)
    };
}

module.exports = {
    buildOracleAccessor,
    buildContractStakeAccessor,
    buildCrossChainAccessor,
    buildAttestationAccessor,
    buildPollAccessor,
    resolveAccessors,
    ACCESSOR_OWN_KEY_ACTIVATION,
    isAccessorOwnKeyActive
};
