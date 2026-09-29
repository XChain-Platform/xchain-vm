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
 * XChain VM Gateway: contract.slash amount-precision ceilings
 *
 * The one home of the slash amount's fractional-digit ceilings and the two
 * amount forms built from them. A zero-dependency leaf, so the gateway
 * (contract_stake.js) and index.js both read it without a require cycle.
 ********************************************************************/
'use strict';

// Fractional-digit ceiling of the pre-activation (legacy) contract.slash amount form.
const SLASH_AMOUNT_LEGACY_DECIMALS = 8;

// Post-activation ceiling. MUST equal the indexer's MAX_TOKEN_DECIMALS
// (xchain-indexer/src/config/token_limits.js); changing it changes which calls emit,
// so it needs a new activation gate and a coordinated edit of every copy.
const MAX_SLASH_AMOUNT_DECIMALS = 18;

// Build one amount form; refuse a non-integer so nothing else is spliced into the regex.
function amountForm(decimals) {
    if (!Number.isSafeInteger(decimals) || decimals < 1)
        throw new Error('slash_limits: decimals must be a positive safe integer, got ' + decimals);
    return new RegExp('^[0-9]+(\\.[0-9]{1,' + decimals + '})?$');
}

const SLASH_AMOUNT_LEGACY_RE = amountForm(SLASH_AMOUNT_LEGACY_DECIMALS);
const SLASH_AMOUNT_WIDE_RE   = amountForm(MAX_SLASH_AMOUNT_DECIMALS);

module.exports = {
    SLASH_AMOUNT_LEGACY_DECIMALS,
    MAX_SLASH_AMOUNT_DECIMALS,
    SLASH_AMOUNT_LEGACY_RE,
    SLASH_AMOUNT_WIDE_RE
};
