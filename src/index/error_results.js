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
 * XChain VM: error results
 *
 * The failure-result shape (state and emissions dropped, logs kept, gas
 * optionally clamped to the ceiling) and the message sanitizer that keeps
 * host paths and stack text out of a result a contract outcome is hashed
 * from. XChainVM prototype methods, installed by the entry (../index.js).
 ********************************************************************/
// @ts-nocheck

module.exports = {
    /**
     * Sanitize an error message to prevent information leakage.
     * Returns only the first line, strips file paths and stack traces.
     */
    sanitizeError(msg) {
        if (!msg) return 'unknown error';
        // Take only the first line
        const firstLine = msg.split('\n')[0];
        // Strip file paths (e.g., /home/user/.../file.js:123:45)
        const sanitized = firstLine.replace(/\s*(\/[\w./-]+(?::\d+(?::\d+)?)?)/g, '');
        // Truncate to 256 chars
        return sanitized.length > 256 ? sanitized.substring(0, 256) : sanitized;
    },

    /**
     * Build a failure result. State changes and emissions are empty (atomicity).
     * Logs are preserved for debugging.
     */
    errorResult(gasTracker, emissionCollector, errorMsg, gasOverride) {
        return {
            success:        false,
            error:          errorMsg,
            // gasOverride bounds the consensus-visible gasUsed to the gas ceiling:
            // for non-deterministic resource terminations (timeout / out_of_memory /
            // out_of_stack) so gasUsed, and therefore the fee, is identical on every
            // validator, and for out_of_gas so a single over-ceiling charge (the
            // allocation wrappers) can never bill the caller beyond their committed budget.
            gasUsed:        (gasOverride != null) ? gasOverride : gasTracker.getUsed(),
            returnValue:    null,
            stateChanges:   [],
            stateDeletes:   [],
            emittedActions: [],
            logs:           emissionCollector.getLogs()
        };
    },
};
