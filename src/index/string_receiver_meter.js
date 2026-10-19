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

const STRING_RECEIVER_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1792454400,
    regtest: 0,
});

function isStringReceiverMeterActive(network, blockTime) {
    const gate = STRING_RECEIVER_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    STRING_RECEIVER_METER_ACTIVATION,
    isStringReceiverMeterActive,
};
