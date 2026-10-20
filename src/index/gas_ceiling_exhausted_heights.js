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
 * Gas-ceiling exhaustion activation map and resolver
 ********************************************************************/
'use strict';

const { resolveRegtestGenesisHeightGate } = require('./height_gates/regtest_genesis.js');

// Activation for settling every run whose gas tracker crossed its ceiling as
// out_of_gas at the ceiling, whichever path the run reached the host by.
//
// A contract can catch an in-isolate gas exhaustion (the Object.* statics
// wrappers swallow it) and then throw a plain Error. That error carries no gas
// class, so the classifier files it as a generic 'error:' and reports the
// tracker's raw total, which can sit up to one full charge above the ceiling
// (measured: 9808 against a 5000 ceiling). The success path has its own gate,
// GAS_CEILING_SUCCESS_ACTIVATION; this one closes the failure paths and, where
// the success gate is not yet armed, the success path too, so that past this
// height no result leaves the VM with gasUsed above the ceiling it ran under.
//
// It moves a run's status (failed to out_of_resource) and its gasUsed, both
// hashed, so it is height-gated per coin. null leaves a chain unarmed; regtest
// runs it from genesis. Twinned with the indexer registry row
// gas_ceiling_exhausted_heights.GAS_CEILING_EXHAUSTED_ACTIVATION, whose UNARMED
// is this map's null; arming one side alone forks.
const GAS_CEILING_EXHAUSTED_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  156908,
    'LTC:testnet':  4927400,
    'DOGE:testnet': 68005165,
});

// Regtest is active from genesis. An unknown network, an unresolvable coin, a
// non-finite height or an unarmed (null) entry all resolve to inactive, the
// replay-safe default.
const resolveGasCeilingExhaustedActive = resolveRegtestGenesisHeightGate;

function isGasCeilingExhaustedActive(network, coin, blockHeight) {
    return resolveGasCeilingExhaustedActive(
        GAS_CEILING_EXHAUSTED_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    GAS_CEILING_EXHAUSTED_ACTIVATION,
    resolveGasCeilingExhaustedActive,
    isGasCeilingExhaustedActive,
};
