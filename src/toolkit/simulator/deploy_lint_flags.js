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
 * Epoch-resolved syntax flags for the DEPLOY gate.
 ********************************************************************/
// @ts-nocheck

const XChainVM = require('../../index.js');
const { isLintOptionalChainActive } = require('../../index/lint_optional_chain_heights.js');
const { isLintBannedWithActive } = require('../../index/lint_banned_with_heights.js');
const { isLintDestructureActive } = require('../../index/lint_destructure_heights.js');
const { isLintSyntaxDepthActive } = require('../../index/lint_syntax_depth_heights.js');
const { resolveRegtestGenesisHeightGate } = require('../../index/height_gates/regtest_genesis.js');
const { LINT_NESTING_DEPTH_HEIGHTS } = require('./constants.js');

function resolveDeployLintFlags({ network, coin, height, time }) {
    const pkg3 = XChainVM.isPkg3SandboxActive(network, coin, height);
    return {
        enforceBannedAsync:       XChainVM.isAsyncSurfaceActive(network, time),
        enforceLintHardening:     XChainVM.isLintHardeningActive(network, time),
        enforceBannedGenerator:   pkg3,
        enforceBannedWasm:        pkg3,
        enforceLintGlobalAlias:   XChainVM.isLintGlobalAliasActive(network, coin, height),
        enforceLintOptionalChain: isLintOptionalChainActive(network, coin, height),
        enforceBannedWith:        isLintBannedWithActive(network, coin, height),
        enforceLintNestingDepth:  resolveRegtestGenesisHeightGate(
            LINT_NESTING_DEPTH_HEIGHTS, network, coin, height),
        enforceLintDestructure:   isLintDestructureActive(network, coin, height),
        enforceBannedRest:        XChainVM.isRestPatternMeterActive(network, time),
        enforceLintSyntaxDepth:   isLintSyntaxDepthActive(network, coin, height)
    };
}

module.exports = { resolveDeployLintFlags };
