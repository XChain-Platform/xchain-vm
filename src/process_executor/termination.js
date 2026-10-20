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
 * XChain VM Process Executor: worker termination outcome
 *
 * What a dispatched execution settles to when its worker dies. A death the
 * contract caused resolves the deterministic clamp below; any other death
 * is a local host fault the executor rejects instead.
 ********************************************************************/
// @ts-nocheck

// Fatal signals a contract can raise in its own worker (V8 abort, native crash).
// Any other signal came from outside (OOM killer, a group SIGTERM): a host fault.
const SELF_INFLICTED_SIGNALS = new Set(['SIGABRT', 'SIGTRAP', 'SIGILL', 'SIGSEGV', 'SIGBUS', 'SIGFPE']);

// A non-zero exit or a SELF_INFLICTED_SIGNALS signal is the contract aborting
// its worker. Exit 0 (the worker's disconnect handler) or an outside signal is not.
function isSelfInflicted(code, signal) {
    return signal ? SELF_INFLICTED_SIGNALS.has(signal) : (Number.isInteger(code) && code !== 0);
}

// Deterministic result for any non-gas host termination (crash / hang).
// gasUsed = ceiling matches src/index.js's timeout/OOM/stack clamp so the
// indexer's fee = gasUsed * GAS_PRICE is identical on every validator.
function hostTerminatedResult(gasCeiling, kind) {
    return {
        success:        false,
        error:          'out_of_resource: execution host terminated (' + kind + ')',
        gasUsed:        gasCeiling,
        returnValue:    null,
        stateChanges:   [],
        stateDeletes:   [],
        emittedActions: [],
        logs:           []
    };
}

module.exports = { isSelfInflicted, hostTerminatedResult };
