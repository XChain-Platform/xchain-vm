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
 * XChain VM Toolkit: Inline determinism gate + gas profiler
 *
 * Author-time feedback that runs the STATIC half of the deploy gate plus a
 * gas-budget estimate, with no isolated-vm dependency. Runs on any OS/CPU
 * (the acorn metering pass and the banned-API/float scanners are pure JS),
 * which is what lets `xchain-foundry lint` give millisecond feedback on a
 * developer's laptop where isolated-vm cannot dlopen.
 *
 * What this does NOT cover (needs the isolate, so it lives in the simulator
 * on Node-22/Linux): the V8 syntax compile. `runGate` therefore reports
 * "static-clean", which is deploy parity for everything acorn can see; a
 * V8-only syntax error (extremely rare, e.g. a duplicate strict-mode
 * binding) still needs `xchain-foundry simulate`.
 ********************************************************************/
// @ts-nocheck

const { lintSource, findFloatWarnings, CONSENSUS_RULES } = require('../lint-core.js');

// Heuristic gas-budget estimate. Ported from xchain-sdk ContractUtils
// .suggestGasLimit (src/contracts.js): a coarse author-time budget, NOT a
// consensus figure. The real cost comes from `simulate` (result.gasUsed);
// this is the "before you even run it" hint.
function estimateGas(sourceCode) {
    const code = String(sourceCode);
    const bytes = Buffer.byteLength(code, 'utf8');

    const base = 50000;
    const perByte = bytes * 10;

    const loops = (code.match(/\b(for|while|do)\b/g) || []).length;
    const functions = (code.match(/\bfunction\b/g) || []).length;
    const emits = (code.match(/xchain\.emit\./g) || []).length;
    const stateOps = (code.match(/xchain\.state\./g) || []).length;

    // A C-style `for` header carries semicolons; for-in / for-of do not. The
    // metering transform charges both the loop body AND the update slot, so a
    // C-style for is billed ~2x/iteration; count it an extra time here.
    const forLoops = (code.match(/\bfor\s*\([^;{)]*;/g) || []).length;

    const complexity = ((loops + forLoops) * 20000) + (functions * 5000) +
        (emits * 5000) + (stateOps * 2000);

    let suggested = base + perByte + complexity;
    suggested = Math.ceil(suggested / 10000) * 10000;
    if (suggested > 1000000) suggested = 1000000;

    return {
        suggested,
        rationale: bytes + ' bytes, ' + functions + ' functions, ' +
            loops + ' loops (' + forLoops + ' indexed for, charged 2x/iteration), ' +
            emits + ' emit calls, ' + stateOps + ' state ops'
    };
}

/**
 * Run the static determinism gate + gas profiler over one contract source.
 * @param {string} code - contract source (already TS-stripped if authored in TS)
 * @returns {{ ok:boolean, errors:Array, advisories:Array, warnings:Array,
 *             gas:{suggested:number,rationale:string} }}
 *   ok         - true when there are zero DEPLOY-BLOCKING errors
 *   errors     - blocking determinism-gate violations (rule in CONSENSUS_RULES;
 *                the on-chain deploy validator rejects exactly these)
 *   advisories - non-blocking analyzer findings (crossCallable integrity, gas
 *                footguns) that never change the deploy verdict
 *   warnings   - float-literal warnings and other non-blocking notes
 *   gas        - heuristic budget estimate
 */
function runGate(code) {
    const lint = lintSource(code);
    const allErrors = lint.errors || [];

    // Deploy parity: the on-chain validator blocks ONLY on CONSENSUS_RULES
    // (see syntax.js validateSyntax). analyzeContract's findings are advisories.
    const errors = allErrors.filter((e) => CONSENSUS_RULES.has(e.rule));
    const advisories = allErrors.filter((e) => !CONSENSUS_RULES.has(e.rule));

    const warnings = Array.isArray(lint.warnings) ? lint.warnings.slice() : [];
    // Defensive: if a future lint-core stops folding float warnings in, keep them.
    if (warnings.length === 0) {
        try {
            for (const w of (findFloatWarnings(code) || [])) warnings.push(w);
        } catch (e) { /* unparseable; errors already captured it */ }
    }

    return {
        ok: errors.length === 0,
        errors,
        advisories,
        warnings,
        gas: estimateGas(code)
    };
}

module.exports = { runGate, estimateGas };
