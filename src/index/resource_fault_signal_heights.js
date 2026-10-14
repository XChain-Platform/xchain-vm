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
 * Resource fault signal activation map and resolver
 *
 * Below this activation the error classifier decides out_of_stack from the
 * thrown value: the recursion guard's exact message, or a RangeError class or
 * name, which contract code can construct, so a contract could settle as
 * out_of_stack with gasUsed clamped to the ceiling without overflowing
 * anything. At and above it the in-isolate depth guards report a trip to the
 * host before they throw, and out_of_stack requires that report. The same
 * activation settles a real memory-limit disposal of the isolate as
 * out_of_memory instead of timeout. Both move settle results, so each network
 * arms at its own per-coin height; null leaves a chain unarmed and regtest
 * runs the rule from genesis.
 ********************************************************************/
'use strict';

const RESOURCE_FAULT_SIGNAL_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
});

function resolveResourceFaultSignalActive(map, network, coin, blockHeight) {
    if (network === 'regtest') return true;
    if (network !== 'testnet' && network !== 'mainnet') return false;

    const height = Number(blockHeight);
    if (!Number.isFinite(height) || coin == null) return false;

    const threshold = map[coin + ':' + network];
    return Number.isFinite(threshold) && height >= threshold;
}

function isResourceFaultSignalActive(network, coin, blockHeight) {
    return resolveResourceFaultSignalActive(
        RESOURCE_FAULT_SIGNAL_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    RESOURCE_FAULT_SIGNAL_ACTIVATION,
    resolveResourceFaultSignalActive,
    isResourceFaultSignalActive,
};
