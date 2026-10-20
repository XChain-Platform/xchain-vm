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
 * Native stack terminal activation map and resolver
 *
 * Below this activation a contract can catch V8's native stack overflow
 * RangeError (or let a finally discard it) and keep running, and large
 * frames or long argument lists reach that overflow before the depth
 * counter, so where it fires, and whether the run succeeds, moves with
 * each node's --stack-size, host stack use and JIT tier. At and above it
 * the metering transform and the harness make any native overflow the
 * same terminal out_of_stack the depth counter raises, charge frames and
 * pushed argument lists against the depth budget, and leave every
 * contract-reachable function source byte-identical below it. Settle
 * results move, so each network arms at its own per-coin height; null
 * leaves a chain unarmed and regtest runs the rule from genesis.
 ********************************************************************/
'use strict';

const { resolveRegtestGenesisHeightGate } = require('../height_gates/regtest_genesis.js');

const NATIVE_STACK_TERMINAL_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  156908,
    'LTC:testnet':  4927400,
    'DOGE:testnet': 68005165,
});

// Resolve this gate through the shared regtest-genesis per-coin height rule.
const resolveNativeStackTerminalActive = resolveRegtestGenesisHeightGate;

function isNativeStackTerminalActive(network, coin, blockHeight) {
    return resolveNativeStackTerminalActive(
        NATIVE_STACK_TERMINAL_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    NATIVE_STACK_TERMINAL_ACTIVATION,
    resolveNativeStackTerminalActive,
    isNativeStackTerminalActive,
};
