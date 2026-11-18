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
 * Environment reads for the VM package, so no other source file touches
 * process.env. Each value is read at call time, never cached.
 ********************************************************************/
// @ts-nocheck

const GUARD_REGTEST_TIME_ENV = 'GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS_REGTEST_TIME';

// Reads the regtest guard activation instant as the indexer row does: 0 when unset or unparsable.
function guardStakeShapeRegtestTime() {
    return parseInt(process.env[GUARD_REGTEST_TIME_ENV]) || 0;
}

module.exports = {
    GUARD_REGTEST_TIME_ENV,
    guardStakeShapeRegtestTime
};
