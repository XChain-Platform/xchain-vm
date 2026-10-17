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

// Activation for the harness_part_5.js charges that ride __applyLengthMeterOn: the
// Function.prototype.apply argument-list length, the receiver length of the array
// callback methods (every, filter, flatMap, forEach, map, reduce, reduceRight, some) and
// the byte length passed to ArrayBuffer resize, transfer and transferToFixedLength. Every
// one moves gasUsed, so it is gated, on a flag day separate from ITER_SET_METER_ACTIVATION
// (runtime/activations.js). Each entry is the block-time instant the rule arms at on that
// network (null leaves it unarmed, 0 runs it from genesis); unknown networks stay unarmed.
const APPLY_LENGTH_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1791804379,
    regtest: 0,
});

function isApplyLengthMeterActive(network, blockTime) {
    const gate = APPLY_LENGTH_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    APPLY_LENGTH_METER_ACTIVATION,
    isApplyLengthMeterActive,
};
