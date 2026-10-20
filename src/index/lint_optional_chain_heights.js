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
 * Optional-chain lint activation map and resolver
 ********************************************************************/
'use strict';

const { resolveRegtestGenesisHeightGate } = require('./height_gates/regtest_genesis.js');

const LINT_OPTIONAL_CHAIN_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  155001,
    'LTC:testnet':  4906040,
    'DOGE:testnet': 67962387,
});

// Resolve this gate through the shared regtest-genesis per-coin height rule.
const resolveOptionalChainActive = resolveRegtestGenesisHeightGate;

function isLintOptionalChainActive(network, coin, blockHeight) {
    return resolveOptionalChainActive(
        LINT_OPTIONAL_CHAIN_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    LINT_OPTIONAL_CHAIN_ACTIVATION,
    resolveOptionalChainActive,
    isLintOptionalChainActive,
};
