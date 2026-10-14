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
 * JSON.stringify re-entry activation map and resolver
 ********************************************************************/
'use strict';

// Activation for re-entrant JSON.stringify on the value-hook path. That path keeps
// its walk state in a frame pool and a forwarded key list shared by every call, so a
// toJSON method, replacer function or getter that calls JSON.stringify itself
// overwrites the outer call's state and the outer call returns the inner result.
// Armed, each nesting level gets its own pool and the forwarded list is restored,
// so nested calls return what the native serializer returns. The fix changes
// contract-visible output and gasUsed, so it is gated: per coin, by block height,
// regtest from genesis. Unarmed (null) or unknown entries keep the shared-pool
// behaviour byte for byte. Only effective where the value-hook path itself is on.
const JSON_STRINGIFY_REENTRY_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
});

function resolveJsonStringifyReentryActive(map, network, coin, blockHeight) {
    if (network === 'regtest') return true;
    if (network !== 'testnet' && network !== 'mainnet') return false;

    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin == null) return false;

    const threshold = map[coin + ':' + network];
    return Number.isFinite(threshold) && height >= threshold;
}

function isJsonStringifyReentryActive(network, coin, blockHeight) {
    return resolveJsonStringifyReentryActive(
        JSON_STRINGIFY_REENTRY_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    JSON_STRINGIFY_REENTRY_ACTIVATION,
    resolveJsonStringifyReentryActive,
    isJsonStringifyReentryActive,
};
