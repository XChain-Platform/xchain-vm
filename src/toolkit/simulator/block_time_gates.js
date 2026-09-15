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
    HEIGHT_GATES,
    GENESIS_ACTIVE_NETWORKS
} = require('./constants.js');

/**
 * The newest gate that has elapsed at `nowSeconds`: the rule set a live chain runs.
 * Takes the instant as an argument and is called per construction rather than once
 * at module load, so a long-lived process straddling a flag day picks the new rules
 * up on its next simulator instead of holding the old ones. The value always snaps
 * to a ratified gate constant, so the only clock dependence is which side of a
 * flag day the host sits on, which is exactly the question being asked.
 *
 * @param {number} [nowSeconds] - unix seconds; defaults to the host clock
 * @returns {number} unix seconds
 */
function liveBlockTime(nowSeconds = Math.floor(Date.now() / 1000)) {
    const elapsed = GATE_BLOCK_TIMES.filter((t) => t <= nowSeconds);
    return elapsed.length ? Math.max(...elapsed) : GATE_FALLBACK_BLOCK_TIME;
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
 * Default simulated block height for (coin, network): the MAX armed threshold across
 * the height gates, so sitting on it activates all of them (every predicate compares
 * with `>=`), exactly as DEFAULT_BLOCK_TIME does for the block-time gates. Read off
 * the VM's exported maps, never retyped, so a newly ratified height needs no edit
 * here. Genesis-active networks and an unrecognized coin/network keep the historical 1.
 */
function defaultBlockHeight(coin, network) {
    if (GENESIS_ACTIVE_NETWORKS.indexOf(network) !== -1) return 1;
    const armed = HEIGHT_GATES
        .map((g) => heightGateThreshold(g, coin, network))
        .filter((t) => Number.isFinite(t));
    return armed.length ? Math.max(...armed) : 1;
}

module.exports = { liveBlockTime, heightGateThreshold, defaultBlockHeight };
