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
 * When a node hands a contract stake amounts as decimal strings. The indexer
 * builds the stake snapshot with mathjs BigNumber amounts and converts them to
 * plain strings only once STAKE_SNAPSHOT_DECIMAL_STRINGS (the call path) or
 * GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS (the controller-guard path) is active.
 * Below those rows, getStake, getTotalStaked and getStakers all return the
 * mathjs JSON form `{ mathjs: 'BigNumber', value }`, with exponent notation for
 * small values. The simulator always serves strings, so this decides when that
 * differs from the chain.
 *
 * Both rows are indexer registry rows with no VM twin, so these tables are a
 * deliberate second home for them. They stay out of TIME_NETWORK_GATES on
 * purpose: they decide a read shape, not a rule set, so they must never move the
 * default block time. test/toolkit/simulator.test/08_stake_shape_gate.test.js
 * compares them against the sibling xchain-indexer rows.
 ********************************************************************/
// @ts-nocheck

const { GUARD_REGTEST_TIME_ENV, guardStakeShapeRegtestTime } = require('../../config.js');

// null is unarmed; 0 is active from genesis. A network not named resolves like mainnet.
const STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES = Object.freeze({
    mainnet: null,
    testnet: 1791804379,
    regtest: 0
});

// The regtest entry is read from the environment like the indexer row is (see guardRegtestTime).
const GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES = Object.freeze({
    mainnet: null,
    testnet: 1792303200,
    regtest: null
});

// The indexer's regtest guard row is `parseInt(env) || 0`, then unarmed when that is 0.
function guardRegtestTime() {
    return guardStakeShapeRegtestTime() || null;
}

/**
 * The activation instant of the row that decides this path's stake shape.
 * @param {string} network
 * @param {boolean} isGuard - the controller-guard path rather than a call
 * @returns {?number} seconds, 0 for genesis, null when unarmed
 */
function stakeDecimalStringsTime(network, isGuard) {
    const table = isGuard ? GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES : STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES;
    const key = Object.prototype.hasOwnProperty.call(table, network) ? network : 'mainnet';
    if (isGuard && key === 'regtest') return guardRegtestTime();
    return table[key];
}

/**
 * Whether a node delivers decimal-string stake amounts at this block time,
 * compared as ProtocolChanges.isEnabled compares a time row: a positive instant
 * is active at and after it, 0 is active from genesis.
 * @param {string} network
 * @param {number} blockTime - seconds
 * @param {boolean} isGuard
 * @returns {boolean}
 */
function isStakeDecimalStringsActive(network, blockTime, isGuard) {
    const at = stakeDecimalStringsTime(network, isGuard);
    if (at === null) return false;
    if (at === 0) return true;
    return Number(blockTime) >= at;
}

module.exports = {
    STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES,
    GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_TIMES,
    GUARD_REGTEST_TIME_ENV,
    stakeDecimalStringsTime,
    isStakeDecimalStringsActive
};
