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

const APPLY_LENGTH_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: null,
    regtest: 0,
});

function isApplyLengthMeterActive(network, blockTime) {
    const gate = APPLY_LENGTH_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    APPLY_LENGTH_METER_ACTIVATION,
    isApplyLengthMeterActive,
};
