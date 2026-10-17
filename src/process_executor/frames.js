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
 * XChain VM Process Executor: reply frame checks
 *
 * The parent dispatches one execution at a time to its worker and accepts
 * a reply only when it answers that dispatch: the reply echoes the random
 * token the dispatch carried, and a result reply carries the fixed result
 * shape every vm.execute() return path builds. A reply that names the
 * in-flight id but fails either check is a worker fault (the executor
 * kills the worker and rejects the run as a host fault), never a result.
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');

// Random per-dispatch value. A counter would also be unique, but only a value
// the worker cannot predict proves the reply was written after the worker
// received this dispatch (a reply queued ahead of it can name the next id).
function newDispatchToken() {
    return crypto.randomBytes(8).toString('hex');
}

// Structural check on a result payload. Deliberately shallow: it only rejects
// payloads the real worker never emits and never re-judges content, so no
// result the worker actually produced is changed or refused.
function isResultShape(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (typeof r.success !== 'boolean') return false;
    if (r.error !== null && typeof r.error !== 'string') return false;
    if (typeof r.gasUsed !== 'number' || !Number.isFinite(r.gasUsed) || r.gasUsed < 0) return false;
    return Array.isArray(r.stateChanges) && Array.isArray(r.stateDeletes) &&
        Array.isArray(r.emittedActions) && Array.isArray(r.logs);
}

// Why a reply for the in-flight id cannot be accepted, or null when it can.
// The caller has already matched msg.id to the in-flight entry.
function replyFault(msg, token) {
    if (typeof token !== 'string' || msg.token !== token) return 'reply does not answer the dispatch in flight';
    if (msg.type === 'result' && !isResultShape(msg.result)) return 'malformed result frame';
    return null;
}

module.exports = { newDispatchToken, isResultShape, replyFault };
