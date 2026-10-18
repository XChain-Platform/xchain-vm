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

const HOST_FAULT_HALT_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  157040,
    'LTC:testnet':  4928000,
    'DOGE:testnet': 68008400,
});

function isHostFaultHaltActive(network, coin, blockHeight) {
    if (network === 'regtest') return true;
    if (network !== 'mainnet' && network !== 'testnet') return false;

    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin == null) return false;

    const threshold = HOST_FAULT_HALT_ACTIVATION[coin + ':' + network];
    return Number.isFinite(threshold) && height >= threshold;
}

module.exports = {
    HOST_FAULT_HALT_ACTIVATION,
    isHostFaultHaltActive,
};
