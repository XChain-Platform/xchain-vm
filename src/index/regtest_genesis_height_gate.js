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
 * Shared resolver for regtest-genesis per-coin height gates
 ********************************************************************/
'use strict';

// Resolve one per-coin height gate: always on for regtest, per-coin height for testnet and mainnet.
// Every *_heights.js map that arms regtest at genesis resolves through here, so the rule has one copy.
// runtime/activation_heights.js keeps its own resolver because it also arms testnet at genesis.
function resolveRegtestGenesisHeightGate(map, network, coin, blockHeight) {
    // Regtest runs every gate from genesis
    if (network === 'regtest') return true;
    // Any network other than testnet or mainnet never activates
    if (network !== 'testnet' && network !== 'mainnet') return false;

    // A height that is not a number, or a missing coin, never activates
    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin == null) return false;

    // An absent or unarmed (null) entry never activates; otherwise compare against the armed height
    const threshold = map[coin + ':' + network];
    return Number.isFinite(threshold) && height >= threshold;
}

module.exports = {
    resolveRegtestGenesisHeightGate,
};
