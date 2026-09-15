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
 * XChain VM Emit API: parameter shape checks
 *
 * The required-field and field-type checks every emit method shares,
 * used by the emit API builder (../gateway_emit.js) and its same-chain
 * emits (same_chain.js).
 ********************************************************************/
// @ts-nocheck

// Required-field validation: params must be an object carrying every named field.
function validateRequired(params, fields) {
    if (typeof params !== 'object' || params === null)
        throw new Error('emit params must be an object');
    for (const field of fields) {
        if (params[field] === undefined || params[field] === null)
            throw new Error('emit: missing required field: ' + field);
    }
}

// Type validation for common emission fields.
// Catches misuse early before reaching the indexer.
function validateTypes(params, typeSpec) {
    for (const [field, type] of Object.entries(typeSpec)) {
        if (params[field] !== undefined && params[field] !== null) {
            if (typeof params[field] !== type)
                throw new Error('emit: field ' + field + ' must be a ' + type + ', got ' + typeof params[field]);
        }
    }
}

module.exports = { validateRequired, validateTypes };
