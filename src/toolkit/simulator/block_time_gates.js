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

const XChainVM = require('../../index.js');
const {
    GATE_BLOCK_TIMES,
    GATE_FALLBACK_BLOCK_TIME,
    isArmedGateTime,
    HEIGHT_GATES,
    TIME_NETWORK_GATES
} = require('./constants.js');

/**
 * Armed, non-genesis instants of the per-network time gates for one network. A 0
 * entry is on from genesis and needs no anchor; an unarmed placeholder never counts.
 * With no network there are none, which keeps the network-agnostic anchors as they were.
 */
function networkGateTimes(network) {
    if (network === undefined) return [];
    return TIME_NETWORK_GATES.map((g) => g.resolve(network)).filter((t) => isArmedGateTime(t) && t > 0);
}

/**
 * The newest gate that has elapsed at `nowSeconds`: the rule set a live chain runs.
 * Takes the instant as an argument and is called per construction rather than once
 * at module load, so a long-lived process straddling a flag day picks the new rules
 * up on its next simulator instead of holding the old ones. The value always snaps
 * to a ratified gate constant, so the only clock dependence is which side of a
 * flag day the host sits on, which is exactly the question being asked.
 *
 * Given a network, that network's elapsed per-network time gates count too, so a
 * testnet simulation sits on testnet's own already-armed instants.
 *
 * @param {number} [nowSeconds] - unix seconds; defaults to the host clock
 * @param {string} [network] - fold in this network's TIME_NETWORK_GATES entries
 * @returns {number} unix seconds
 */
function liveBlockTime(nowSeconds = Math.floor(Date.now() / 1000), network) {
    const elapsed = GATE_BLOCK_TIMES.concat(networkGateTimes(network)).filter((t) => t <= nowSeconds);
    return elapsed.length ? Math.max(...elapsed) : GATE_FALLBACK_BLOCK_TIME;
}

/**
 * The preview anchor: the newest ARMED gate, elapsed or not, scalar or (given a
 * network) per-network. The fallback is the same ratified literal liveBlockTime uses.
 *
 * @param {string} [network]
 * @returns {number} unix seconds
 */
function scheduledBlockTime(network) {
    const armed = GATE_BLOCK_TIMES.concat(networkGateTimes(network));
    return armed.length ? Math.max(...armed) : GATE_FALLBACK_BLOCK_TIME;
}

/**
 * Every armed gate dated after `live` (scalar, plus the network's own), named with
 * its epoch and UTC date, for the scheduled-mode preview warning.
 */
function gatesAheadOf(live, network) {
    const at = (t) => ' (' + t + ', ' + new Date(t * 1000).toISOString() + ')';
    const scalar = Object.keys(XChainVM)
        .filter((k) => /_GATE_BLOCK_TIME$/.test(k) && isArmedGateTime(XChainVM[k]) && XChainVM[k] > live)
        .map((k) => k + at(XChainVM[k]));
    const perNetwork = network === undefined ? [] : TIME_NETWORK_GATES
        .map((g) => ({ label: g.label, t: g.resolve(network) }))
        .filter(({ t }) => isArmedGateTime(t) && t > live)
        .map(({ label, t }) => label + ' on ' + network + at(t));
    return scalar.concat(perNetwork);
}

/**
 * Armed threshold for one height gate at (coin, network), or undefined.
 * EXEC_LINT / LINT_GLOBAL_ALIAS now carry an explicit `0` on every mainnet coin
 * (ARMED at genesis by the 2026-09-09 ruling); a missing entry or a non-finite
 * height is still filtered out rather than coerced to 0.
 */
function heightGateThreshold(gate, coin, network) {
    const map = XChainVM[gate.map];
    if (!map || coin == null) return undefined;
    const t = map[String(coin) + ':' + String(network)];
    return Number.isFinite(t) ? t : undefined;
}

/**
 * Lowest height at which one height gate is on for (coin, network), or undefined when
 * it is unarmed there. Genesis activation is asked of the gate's own predicate, so a
 * gate that is genesis-on for regtest only (the optional-chain refinement) still needs
 * its armed threshold on testnet.
 */
function heightGateNeed(gate, coin, network) {
    if (XChainVM[gate.isActive](network, coin, 1) === true) return 1;
    return heightGateThreshold(gate, coin, network);
}

/**
 * Default simulated block height for (coin, network): the MAX height any gate needs,
 * so sitting on it activates all of them (every predicate compares with `>=`), exactly
 * as DEFAULT_BLOCK_TIME does for the block-time gates. Read off the VM's exported maps
 * and predicates, never retyped, so a newly ratified height needs no edit here. With no
 * armed gate (an unrecognized coin or network) it keeps the historical 1.
 */
function defaultBlockHeight(coin, network) {
    const needs = HEIGHT_GATES
        .map((g) => heightGateNeed(g, coin, network))
        .filter((t) => Number.isFinite(t));
    return needs.length ? Math.max(...needs) : 1;
}

module.exports = {
    liveBlockTime, scheduledBlockTime, networkGateTimes, gatesAheadOf,
    heightGateThreshold, heightGateNeed, defaultBlockHeight
};
