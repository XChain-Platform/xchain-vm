/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

// Activation for three corrections at the host-call boundary. Each one moves gasUsed or
// status, so they share one gate:
//   - emission cap before charge: emit.execute, emit.crossExecute and attestation.request
//     check the emission cap BEFORE charging their reservation, prepay or request fee, so
//     a refused emission at the cap is not billed for work that was never queued;
//   - cyclic values: the F-NR value guard and the JSON.stringify hook pass detect a value
//     that contains itself on its own path and throw a catchable TypeError after the nodes
//     already walked, instead of running the cycle to the depth limit and faulting
//     out_of_stack at the gas ceiling;
//   - host-call argument depth: wrap() serializes host-call arguments inside one array,
//     and the depth guards allow that one level, so an argument holds the same documented
//     __NR_DEPTH_LIMIT nesting a plain JSON.stringify of it does.
// Each entry is the block-time instant the rule arms at on that network (null leaves it
// unarmed, 0 runs it from genesis); unknown networks stay unarmed.
const HOST_CALL_BOUNDS_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1792303200,
    regtest: 0,
});

function isHostCallBoundsActive(network, blockTime) {
    const gate = HOST_CALL_BOUNDS_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    HOST_CALL_BOUNDS_ACTIVATION,
    isHostCallBoundsActive,
};
