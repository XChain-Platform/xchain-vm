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

// Activation for the per-element charges in harness_part_5.js that ride __perElemMeterOn.
// Four native built-in families charged a constant per call while their work grows with
// the input, so a single call could run tens of milliseconds for a few dozen gas:
//   - Iterator.prototype helpers: 1 gas per callback invocation (map, filter, flatMap,
//     reduce, forEach, some, every, find) and 1 gas per value an iterator helper yields
//     (map, filter, take, drop, flatMap), so a native callback such as Math.abs, which
//     skips the function-entry charge, no longer walks the input for free;
//   - Set.prototype set algebra with an argument that is not a plain Set: 1 gas per key
//     the argument's keys() iterator yields, plus the receiver's size, instead of trusting
//     the argument's self-reported size;
//   - String.raw: 1 gas per raw segment on top of the result-length charge;
//   - object spread and object rest: 1 gas per copied key from the first key, instead of
//     only above the 256-key growth threshold.
// Every one moves gasUsed, so it is gated on its own table, separate from
// ITER_SET_METER_ACTIVATION (runtime/activations.js) and APPLY_LENGTH_METER_ACTIVATION
// (apply_length_meter.js). Each entry is the block-time instant the rule arms at on that
// network (null leaves it unarmed, 0 runs it from genesis); unknown networks stay unarmed.
// Arming mainnet or testnet is a coordinated release event with an operator ruling.
const PER_ELEMENT_METER_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1792303200,
    regtest: 0,
});

function isPerElementMeterActive(network, blockTime) {
    const gate = PER_ELEMENT_METER_ACTIVATION[network];
    return Number.isFinite(gate) &&
        (gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate));
}

module.exports = {
    PER_ELEMENT_METER_ACTIVATION,
    isPerElementMeterActive,
};
