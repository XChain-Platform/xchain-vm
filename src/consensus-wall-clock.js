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
 * XChain VM: the CONSENSUS wall-clock budget for one contract execution.
 *
 * WHY THIS EXISTS
 * Gas is the deterministic meter, but gas does not bound wall time: the VM's
 * own history is a sequence of discovering native shapes whose wall-time-per-
 * gas is far above the schedule's assumption (a 120k-char decodeURIComponent
 * loop burned ~13.5 s of wall clock while gasUsed stayed at ~540k; see the
 * F3-globals note in index.js). For those shapes the WALL-CLOCK net, not the
 * gas ceiling, is the constraint that actually terminates the execution.
 *
 * That net used to be `limits.maxCpuTimeMs`, a per-NODE configuration value
 * (30000 by default) explicitly documented as "not a consensus value". Two
 * validators configured differently therefore disagreed about the same
 * execution: the one with the tighter budget returned
 * `timeout: wall-clock safety net triggered` with gasUsed clamped to the
 * ceiling, the one with the looser budget committed the execution's real state
 * changes and its real gasUsed. Status and gasUsed are both consensus-visible
 * (gasUsed drives the fee debit and the per-block contract checkpoint), so the
 * difference is a fork, produced by a config file rather than by a rule.
 *
 * The bound below removes the operator from that decision: at/after the
 * coordinated flag-day the per-execution wall-clock budget is this protocol
 * CONSTANT on every node, whatever the node's own `maxCpuTimeMs` says. The
 * knob keeps its meaning only for ungated (pre-flag-day / non-consensus) use
 * such as benches, fuzzing and the toolkit simulator, so historical blocks
 * replay byte-identically.
 *
 * WHY 30000
 * It is the documented default the fleet already runs, so promoting it to a
 * protocol constant changes the outcome of NO execution on a default-configured
 * node: this change closes the heterogeneity fork surface without also moving
 * the bound. The magnitude is a separate question with a real cost (a measured
 * worst-case EXECUTE burns the 1,000,000-gas ceiling in ~750 ms, so 30 s is
 * roughly 40x the metered worst case, which is exactly why batch cost weights
 * grounded on a gas-ceiling burn are grounded on today's metering coverage and
 * not on this bound). Tightening it is a consensus TIGHTENING: it must ride its
 * own future flag-day, re-golden the determinism baselines, and deploy
 * fleet-wide atomically. Do not edit this value to make a slow box or a slow
 * test pass.
 *
 * Zero dependencies on purpose: index.js (the enforcing path) and
 * process-executor.js (the parent-side watchdog that must never fire before
 * the in-isolate bound) both read it without a require cycle.
 ********************************************************************/
// @ts-nocheck

// Consensus wall-clock budget for ONE contract execution, milliseconds.
// Pinned by test/determinism/consensus-params.test.js; a node running a
// different value forks the fleet on the first execution that reaches it.
const CONSENSUS_MAX_WALL_MS = 30000;

/**
 * The wall-clock budget one execution runs against.
 *
 * @param {boolean} gated       whether the consensus bound is active for this
 *                              execution (network + block time; the resolver
 *                              lives in index.js beside the flag-day constant).
 * @param {number}  nodeLimitMs the node's own limits.maxCpuTimeMs, which binds
 *                              ONLY while the execution is ungated.
 * @returns {number} milliseconds passed to the isolate's execution timeout.
 */
function resolveWallClockBudgetMs(gated, nodeLimitMs) {
    if (gated) return CONSENSUS_MAX_WALL_MS;
    return nodeLimitMs;
}

module.exports = {
    CONSENSUS_MAX_WALL_MS,
    resolveWallClockBudgetMs
};
