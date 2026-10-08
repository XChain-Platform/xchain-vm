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
 * BigInt surface strip activation map and resolver
 ********************************************************************/
'use strict';

const BIGINT_SURFACE_STRIP_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
});

function resolveBigIntSurfaceStripActive(map, network, coin, blockHeight) {
    if (network === 'regtest') return true;
    if (network !== 'testnet' && network !== 'mainnet') return false;

    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin == null) return false;

    const threshold = map[coin + ':' + network];
    return Number.isFinite(threshold) && height >= threshold;
}

function isBigIntSurfaceStripActive(network, coin, blockHeight) {
    return resolveBigIntSurfaceStripActive(
        BIGINT_SURFACE_STRIP_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    BIGINT_SURFACE_STRIP_ACTIVATION,
    resolveBigIntSurfaceStripActive,
    isBigIntSurfaceStripActive,
};
