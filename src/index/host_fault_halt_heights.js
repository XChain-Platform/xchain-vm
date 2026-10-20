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
 * Host-fault halt activation map and resolver
 ********************************************************************/
'use strict';

const { resolveRegtestGenesisHeightGate } = require('./regtest_genesis_height_gate.js');

const HOST_FAULT_HALT_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  157073,
    'LTC:testnet':  4928460,
    'DOGE:testnet': 68009330,
});

function isHostFaultHaltActive(network, coin, blockHeight) {
    return resolveRegtestGenesisHeightGate(HOST_FAULT_HALT_ACTIVATION, network, coin, blockHeight);
}

module.exports = {
    HOST_FAULT_HALT_ACTIVATION,
    isHostFaultHaltActive,
};
