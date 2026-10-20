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

const { resolveRegtestGenesisHeightGate } = require('./height_gates/regtest_genesis.js');

const BIGINT_SURFACE_STRIP_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  156230,
    'LTC:testnet':  4912984,
    'DOGE:testnet': 67989993,
});

// Resolve this gate through the shared regtest-genesis per-coin height rule.
const resolveBigIntSurfaceStripActive = resolveRegtestGenesisHeightGate;

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
