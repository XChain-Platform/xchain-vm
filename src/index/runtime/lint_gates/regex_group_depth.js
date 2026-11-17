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
 * XChain VM: regex group-nesting lint activation
 *
 * The flag-day gate for refusing regex literals nested past the fixed
 * lint-core group bound; activations.js re-exports it.
 ********************************************************************/
// @ts-nocheck

// Activation for refusing regex literals whose group nesting exceeds the fixed
// lint-core bound. Mainnet stays unarmed, testnet arms at the v0.27.0 cut, and
// regtest exercises the rule from genesis. Unknown networks stay unarmed.
const LINT_REGEX_GROUP_DEPTH_ACTIVATION = Object.seal({
    mainnet: null,
    testnet: 1794873600,
    regtest: 0,
});

function isLintRegexGroupDepthActive(network, blockTime) {
    const gate = LINT_REGEX_GROUP_DEPTH_ACTIVATION[network];
    if (!Number.isFinite(gate)) return false;
    return gate === 0 || (Number.isFinite(blockTime) && blockTime >= gate);
}

module.exports = {
    LINT_REGEX_GROUP_DEPTH_ACTIVATION,
    isLintRegexGroupDepthActive,
};
