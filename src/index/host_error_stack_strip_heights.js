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
 * Host-thrown error stack strip activation map and resolver
 *
 * An error a gateway function throws on the host side reaches the contract
 * as an error isolated-vm builds, and its stack is isolated-vm's boundary
 * frame plus the harness position of the wrap() applySync call
 * ("<isolated-vm>:10:34"). A contract can store that text, so hashed state
 * would depend on the harness source bytes and on isolated-vm's frame format.
 * At/after this activation the harness rethrows every host-thrown error as a
 * fresh in-isolate error of the same constructor and message, whose stack is
 * "" like any other in-isolate error. That changes what a contract reads, so
 * it is height-gated per coin: regtest from genesis, mainnet and testnet
 * unarmed (null) until a release cut sets their heights; an unknown network,
 * an unresolvable coin or a non-finite height resolves to the legacy text.
 ********************************************************************/
'use strict';

const { resolveBigIntSurfaceStripActive } = require('./bigint_surface_strip_heights.js');

const HOST_ERROR_STACK_STRIP_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  null,
    'LTC:testnet':  null,
    'DOGE:testnet': null,
});

// Same resolution rule as the BigInt surface strip: regtest on from genesis,
// mainnet/testnet by the per-coin threshold, anything else off.
function isHostErrorStackStripActive(network, coin, blockHeight) {
    return resolveBigIntSurfaceStripActive(
        HOST_ERROR_STACK_STRIP_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    HOST_ERROR_STACK_STRIP_ACTIVATION,
    isHostErrorStackStripActive,
};
