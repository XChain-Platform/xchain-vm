/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Pinned consensus runtime — the engine the validator fleet agrees on.
 *
 * WHY THIS EXISTS
 * Some contract-observable values are produced by the JS engine, are NOT
 * spec-mandated, and have changed across engine versions:
 *   - native V8 error message TEXT (e.message / e.stack wording) — e.g.
 *     "Cannot read property 'x' of undefined" became
 *     "Cannot read properties of undefined (reading 'x')" at V8 8.4;
 *   - ICU-backed collation / normalization / number+date formatting
 *     (Intl is stripped in the sandbox, but Unicode/CLDR data versions
 *     still govern any residual locale-sensitive primitive).
 * A contract can route such a value into HASHED state (state write, or a
 * returnValue the caller stores). Two validators on different V8/ICU builds
 * would then commit different bytes for the same contract → divergent
 * Merkle root → CHAIN FORK. These engine versions are therefore
 * consensus-critical and MUST freeze with the wire format (LAUNCH-PLAN
 * track 8/9).
 *
 * This is the deployment-side mitigation for the documented, not-in-VM-
 * fixable `e.message` residual (see test/determinism/probe-error-message-
 * determinism.js): you cannot sanitize a value V8 sets internally, so you
 * instead PIN the engine that sets it and GATE every validator against the
 * pin. `checkConsensusRuntime()` powers that gate
 * (test/determinism/consensus-runtime-gate.test.js, in `ci`).
 *
 * RE-PINNING IS A CONSENSUS EVENT. Do not bump these to silence a failing
 * gate on a dev box running a different Node. Either run the canonical
 * runtime, or — if the fleet is deliberately upgrading its engine — re-pin
 * here AND regenerate the determinism manifests AND coordinate an atomic
 * fleet activation (a mixed-engine fleet can fork). The canonical runtime
 * below was confirmed BYTE-IDENTICAL on linux/arm64 and linux/amd64
 * (node:22-bookworm) on 2026-06-07.
 ********************************************************************/
// @ts-nocheck

// The pinned set. KEYS are process.versions keys; VALUES are the exact
// strings the fleet runs. Only engine-level, consensus-affecting versions
// belong here (V8 + the ICU/Unicode/CLDR data that governs locale-sensitive
// primitives). The Node ABI ('modules') is pinned too: a different ABI means
// a different V8/ICU build and an incompatible isolated-vm binary.
const PINNED = Object.freeze({
    v8:      '12.4.254.21-node.56',
    icu:     '78.2',
    unicode: '17.0',
    cldr:    '48.0',
    modules: '127'
});

// The reference Node release the pin was taken from. Informational only:
// a different Node PATCH that carries the SAME v8/icu/unicode/cldr/modules
// is consensus-equivalent and intentionally NOT rejected. Recorded so the
// gate's failure message can name the canonical release to install.
const REFERENCE_NODE = 'v22.22.3';

/**
 * Compare a process.versions-shaped object against the pinned consensus
 * runtime. Pure (no throw, no I/O) so callers decide how to react.
 *
 * @param {object} [versions=process.versions]
 * @returns {{ ok: boolean, mismatches: Array<{key:string, expected:string, actual:(string|undefined)}> }}
 */
function checkConsensusRuntime(versions) {
    const v = versions || process.versions;
    const mismatches = [];
    for (const key of Object.keys(PINNED)) {
        const actual = v[key];
        if (actual !== PINNED[key]) {
            mismatches.push({ key, expected: PINNED[key], actual });
        }
    }
    return { ok: mismatches.length === 0, mismatches };
}

/**
 * Human-readable explanation for a failed check, suitable for a gate
 * assertion message or an operator-facing warning.
 *
 * @param {{mismatches: Array<{key:string, expected:string, actual:string}>}} result
 * @returns {string}
 */
function describeMismatch(result) {
    if (!result || result.ok) return 'consensus runtime matches the pin';
    const lines = result.mismatches.map(m =>
        `  ${m.key}: running ${JSON.stringify(m.actual)} != pinned ${JSON.stringify(m.expected)}`);
    return (
        'CONSENSUS RUNTIME MISMATCH — this engine can produce different ' +
        'contract-observable bytes (V8 error text / ICU-backed primitives) ' +
        'than the rest of the fleet, which would FORK the chain:\n' +
        lines.join('\n') +
        `\nInstall the canonical runtime (${REFERENCE_NODE}, node:22-bookworm) ` +
        'or, if the fleet is deliberately upgrading, re-pin src/consensus-runtime.js ' +
        '+ regenerate the determinism manifests + coordinate an atomic fleet activation.'
    );
}

module.exports = { PINNED, REFERENCE_NODE, checkConsensusRuntime, describeMismatch };
