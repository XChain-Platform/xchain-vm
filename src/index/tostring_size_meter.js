/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

// Activation for the toString size meter. Mainnet stays deferred on the unarmed
// sentinel, testnet arms at the block time in its row below, and regtest runs the
// rule from genesis. Unknown networks resolve like mainnet so cannot arm it early.
const TOSTRING_SIZE_METER_GATE_BLOCK_TIME = 9999999999;
const TOSTRING_SIZE_METER_ACTIVATION = Object.seal({
    mainnet: TOSTRING_SIZE_METER_GATE_BLOCK_TIME,
    testnet: 1792454400,
    regtest: 0,
});

function toStringSizeMeterGateTime(network) {
    const gate = TOSTRING_SIZE_METER_ACTIVATION[network];
    return Number.isFinite(gate) ? gate : TOSTRING_SIZE_METER_ACTIVATION.mainnet;
}

function isToStringSizeMeterActive(network, blockTime) {
    const gate = toStringSizeMeterGateTime(network);
    return gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate);
}

module.exports = {
    TOSTRING_SIZE_METER_GATE_BLOCK_TIME,
    TOSTRING_SIZE_METER_ACTIVATION,
    toStringSizeMeterGateTime,
    isToStringSizeMeterActive,
};
