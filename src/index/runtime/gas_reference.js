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
 * XChain VM: gas callback
 *
 * The __gas reference the metering and allocation wrappers charge through.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');
const { GasExhaustedError } = require('../../errors.js');
const { BINARY_ALLOC_GATE_BLOCK_TIME } = require('./activations.js');

function makeGasReference(gasTracker, opts) {
        // Inject __gas callback for metering. `units` is the number of
        // computation steps to charge: the AST meter passes 1 (control flow);
        // the allocation-metering wrappers (harness) pass the requested
        // allocation size, so a bulk allocation trips the gas ceiling BEFORE V8
        // services it. Sanitize to a positive integer (default 1); a huge units
        // deterministically throws GasExhaustedError at the ceiling.
        //
        // NON-FINITE gate (2437). The legacy sanitizer collapsed Infinity/NaN to
        // n=1, which broke that invariant exactly where it matters most: a
        // wrapper that computes a non-finite size is one that could NOT bound the
        // allocation, so it is the case that most needs to fail closed. It is
        // reachable and it is not free. Array.prototype.fill.call({length:
        // Infinity}, 1) reaches the wrapper as __allocGas(Infinity), bills a
        // single gas unit, and V8 then services ToLength(Infinity) = 2^53-1
        // iterations, burning the whole wall-clock net (measured ~30s) for ~0
        // gas. The same call with a FINITE length of 2^53-1 charges 2^53-1 and
        // is a deterministic out_of_gas in ~10ms. So charge the identical
        // maximal amount for a non-finite size: Number.MAX_SAFE_INTEGER, a fixed
        // constant (not ceiling-derived) so the resulting `used` value, and
        // therefore the hashed out_of_gas message, does not vary with the
        // caller-supplied ceiling and matches the finite 2^53-1 path exactly.
        // A NON-number `units` still resolves to 1: that is the AST meter's own
        // default, not a failed size computation.
        // CONSENSUS GATE: this turns a 1-gas timeout into a ceiling-clamped
        // out_of_gas, which moves the hashed status and gasUsed, so it rides the
        // same already-armed block-time flag-day as F3-binary/globals + F-NR +
        // F-MO + F-PS. Below the gate the legacy collapse-to-1 replays unchanged.
        const __gasBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
        const nonFiniteFailClosed = Number.isFinite(__gasBlockTime) &&
            __gasBlockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
        return new ivm.Reference(function(units) {
            try {
                const nonFinite = (typeof units === 'number' && !isFinite(units));
                const n = nonFinite && nonFiniteFailClosed
                    ? Number.MAX_SAFE_INTEGER
                    : ((typeof units === 'number' && isFinite(units) && units >= 1) ? Math.floor(units) : 1);
                gasTracker.charge(gasTracker.schedule.VM_COMPUTATION * n);
            } catch (e) {
                if (e instanceof GasExhaustedError) {
                    throw new Error('\x03GAS:' + e.used + ':' + e.ceiling);
                }
                throw e;
            }
        });
}

module.exports = { makeGasReference };
