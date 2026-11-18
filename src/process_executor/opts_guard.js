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
 ********************************************************************/
// @ts-nocheck

// Read-only data opts and the method each one's legacy closure accessor exposes
// (the probes readonly-accessors.js uses to tell an accessor from a snapshot).
const ACCESSOR_PROBES = {
    oracleData: 'getPrice',
    crossChainData: 'getAttestation',
    attestationData: 'getResponse',
    contractStakeData: 'getStake',
    pollData: 'getPollResult'
};

/**
 * The in-process executor still accepts a closure accessor for these opts. The
 * worker channel is JSON, which drops function-valued properties without error,
 * so the worker would read an empty snapshot and return a normal-looking result
 * that differs from the in-process one. Name the first such field so the
 * dispatch can be refused instead.
 * @returns {?string} the offending opts key, or null when every field can cross
 */
function closureAccessorField(opts) {
    if (!opts || typeof opts !== 'object') return null;
    for (const [field, probe] of Object.entries(ACCESSOR_PROBES)) {
        const value = opts[field];
        if (value && typeof value[probe] === 'function') return field;
    }
    return null;
}

module.exports = { closureAccessorField };
