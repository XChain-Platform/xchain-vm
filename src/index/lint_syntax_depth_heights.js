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
 * Syntax-depth lint activation map and resolver
 *
 * At or above a chain's threshold the deploy and execute-time lint refuse a
 * source whose syntactic depth (every construct the parsers and the metering
 * pass recurse on, not only delimiters) exceeds the fixed bound, before any
 * recursive pass runs; deploy also enforces the delimiter-nesting rule, as the
 * execute-time lint always has; and a host stack overflow anywhere in lint or
 * metering is a host fault, never a verdict. Below it every path is unchanged.
 * A null threshold leaves that chain unarmed; regtest is always active.
 ********************************************************************/
'use strict';

const { resolveRegtestGenesisHeightGate } = require('./height_gates/regtest_genesis.js');

const LINT_SYNTAX_DEPTH_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    'BTC:testnet':  156908,
    'LTC:testnet':  4927400,
    'DOGE:testnet': 68005165,
});

// Resolve this gate through the shared regtest-genesis per-coin height rule.
const resolveSyntaxDepthActive = resolveRegtestGenesisHeightGate;

function isLintSyntaxDepthActive(network, coin, blockHeight) {
    return resolveSyntaxDepthActive(
        LINT_SYNTAX_DEPTH_ACTIVATION,
        network,
        coin,
        blockHeight
    );
}

module.exports = {
    LINT_SYNTAX_DEPTH_ACTIVATION,
    resolveSyntaxDepthActive,
    isLintSyntaxDepthActive,
};
