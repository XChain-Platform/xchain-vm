/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Action Validator
 *
 * Lightweight pre-validation of emitted actions before returning
 * to the indexer. Catches obvious errors early.
 ********************************************************************/

const ALLOWED_ACTIONS = new Set([
    'SEND', 'DESTROY', 'ISSUE', 'MINT', 'ORDER',
    'DISPENSER', 'DIVIDEND', 'AIRDROP', 'CALLBACK',
    'FILE', 'LIST', 'COINPAY', 'SWEEP', 'LINK', 'BROADCAST', 'MESSAGE',
    'ATTEST', 'SLASH', 'EXECUTE'
]);

class ActionValidator {
    validate(action) {
        if (!ALLOWED_ACTIONS.has(action.action))
            throw new Error('unknown emission action: ' + action.action);

        if (typeof action.params !== 'object' || action.params === null)
            throw new Error('emission params must be an object');

        return true;
    }
}

module.exports = ActionValidator;
