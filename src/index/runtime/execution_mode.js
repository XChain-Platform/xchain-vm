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
 * XChain VM: execution mode
 *
 * Validates the configured execution mode.
 ********************************************************************/
// @ts-nocheck

function assertExecutionMode(mode) {
    // The mode string is validated against the two known values: with a bare
    // `config.execution || 'in-process'` fallback, a typo ('subproces',
    // 'sub-process', trailing space) would SILENTLY run in-process and drop
    // host-crash containment (the exact failure the subprocess layer exists
    // to prevent. Unknown values throw at construct time instead.
    if (mode !== undefined && mode !== 'in-process' && mode !== 'subprocess') {
        throw new Error("XChainVM: unknown execution mode '" + mode +
            "' use 'subprocess' (production) or 'in-process'");
    }
}

module.exports = { assertExecutionMode };
