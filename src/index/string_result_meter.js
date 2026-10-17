/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * GENERATED
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

// Block-time activation for string-result metering. Null leaves a network
// unarmed, while zero activates the rule from genesis. Unknown networks fail
// closed.
const STRING_RESULT_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: null,
    regtest: 0,
});

function isStringResultMeterActive(network, blockTime) {
    const gate = STRING_RESULT_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    STRING_RESULT_METER_ACTIVATION,
    isStringResultMeterActive,
};
