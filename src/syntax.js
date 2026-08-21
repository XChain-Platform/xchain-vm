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
 * XChain VM: Syntax Validation
 *
 * Deploy-time validation: V8 syntax check (the only step needing
 * isolated-vm), then the acorn-coverable rules (metering pass, reserved
 * identifiers, banned Math.*, banned literals, and float warnings) which
 * live in the dependency-light, vendorable ./lint-core.js. Keeping the
 * rules in one place guarantees the deploy path and the SDK/CLI linter
 * never diverge.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');
const { HostFaultError } = require('./errors.js');
const { lintSource, findFloatWarnings, findBannedMathCalls, findBannedLiterals, findBannedAsync, findBannedGenerator, findBannedWasm, CONSENSUS_RULES } = require('./lint-core.js');

/**
 * Validate contract code syntax before deployment. Runs a V8 syntax check
 * (the only step needing isolated-vm) then the acorn-coverable consensus rules
 * via lint-core.lintSource(); error messages are byte-identical to the
 * historical output, so the on-chain deploy verdict is unchanged.
 *
 * @param {string} code - Contract source code
 * @param {object} [opts]
 * @param {boolean} [opts.enforceBannedAsync=true] - whether the 'banned-async'
 *        rule (async/await/Promise) is deploy-blocking. CONSENSUS-GATED: the
 *        indexer passes the resolved VM_BANNED_ASYNC flag-day activation
 *        (deploy.js) so that BELOW the flag day an async/Promise DEPLOY resolves
 *        exactly as it did pre-activation (accepted), and a from-genesis replay
 *        reproduces the historical verdict. Defaults to true so author-facing
 *        callers (the SDK/CLI linter, unit tests) always see the rule.
 * @param {boolean} [opts.enforceLintHardening=true] - whether the
 *        VM_LINT_HARDENING rule set (exponentiation ban, reserved control
 *        bindings, SAFE_MATH complement, dynamic import(), shorthand
 *        { Promise }, shadowed-local Promise relaxation) applies. CONSENSUS-
 *        GATED identically to enforceBannedAsync: the indexer passes the
 *        resolved VM_LINT_HARDENING activation (deploy.js) so a from-genesis
 *        replay reproduces historical verdicts. Defaults to true.
 * @param {boolean} [opts.enforceLintGlobalAlias=true] - whether the
 *        LINT_GLOBAL_ALIAS refinement applies: sloppy-mode `this` and the
 *        `globalThis.globalThis...` self-reference chain count as the global
 *        object for the banned-async, banned-wasm and banned-math rules.
 *        CONSENSUS-GATED on
 *        its OWN per-coin block-HEIGHT epoch rather than VM_LINT_HARDENING's,
 *        because that gate is already open on every network and riding it would
 *        retroactively reject contracts the chain already accepted. The indexer
 *        passes the resolved activation (deploy.js). Defaults to true.
 * @param {boolean} [opts.enforceBannedGenerator=true] - whether the
 *        'banned-generator' rule (function*, generator methods, yield) is
 *        deploy-blocking. CONSENSUS-GATED identically to enforceBannedAsync, but
 *        on the Pkg 3 per-coin block-HEIGHT flag-day (not a block-time gate): the
 *        indexer passes the resolved activation (deploy.js) so BELOW the height a
 *        generator DEPLOY resolves exactly as it did pre-activation (accepted)
 *        and a from-genesis replay reproduces the historical verdict. Defaults to
 *        true so author-facing callers (SDK/CLI linter, unit tests) always see it.
 * @param {boolean} [opts.enforceBannedWasm=true] - whether the 'banned-wasm' rule
 *        (a reference to the global WebAssembly) is deploy-blocking. The deploy
 *        half of the Pkg 3 WebAssembly strip, CONSENSUS-GATED identically to
 *        enforceBannedGenerator on the same per-coin height flag-day. Defaults to
 *        true.
 * @returns {{ valid: boolean, error?: string }}
 * @throws {HostFaultError} when the V8 isolate cannot be SPAWNED on this host
 *         (code 'EXECUTOR_UNAVAILABLE'). Never a contract outcome: callers on
 *         the consensus path must halt and retry rather than record a verdict,
 *         and author-facing callers must report a machine fault rather than a
 *         source defect.
 */
function validateSyntax(code, opts) {
    const enforceBannedAsync     = !opts || opts.enforceBannedAsync !== false;
    const enforceLintHardening   = !opts || opts.enforceLintHardening !== false;
    const enforceLintGlobalAlias = !opts || opts.enforceLintGlobalAlias !== false;
    const enforceBannedGenerator = !opts || opts.enforceBannedGenerator !== false;
    const enforceBannedWasm      = !opts || opts.enforceBannedWasm !== false;

    // 1. V8 syntax check (the only step that requires isolated-vm).
    //
    // Spawn and compile are caught SEPARATELY, and the split is load-bearing.
    // A compileScriptSync failure is a deterministic property of the source, so
    // it is a contract verdict. A failure to SPAWN the isolate (host memory
    // pressure, thread-creation failure, a native binding that loaded but
    // cannot create isolates) is a property of THIS machine. Reporting the host
    // fault as 'syntax error: ...' let deploy.js commit
    // 'invalid: CODE_ENCODING' for a contract every healthy peer accepts: a
    // validator-local, host-condition-induced ledger divergence, the same class
    // the deploy.js EXECUTOR_UNAVAILABLE throw exists to close for a VM that
    // failed to load at all. HostFaultError carries that code, which
    // faultGuard.rethrowIfInfraFault treats as an infra halt, so the block
    // rolls back and retries and NO verdict is written.
    let testIsolate;
    try {
        try {
            testIsolate = new ivm.Isolate({ memoryLimit: 8 });
        } catch (e) {
            throw new HostFaultError('syntax validation isolate unavailable: ' + e.message);
        }
        try {
            testIsolate.compileScriptSync(code);
        } catch (e) {
            return { valid: false, error: 'syntax error: ' + e.message };
        }
    } finally {
        try { if (testIsolate) testIsolate.dispose(); } catch (e) {}
    }

    // 2-5. Acorn-coverable consensus rules. Block ONLY on consensus rules;
    // lintSource also returns Move-2 advisory findings, which must never change
    // the on-chain verdict. When a flag-day rule is not yet active, drop it from
    // the blocking set (pre-activation parity): banned-async on the block-time
    // async gate, banned-generator/banned-wasm on the Pkg 3 per-coin height gate.
    const blocking = lintSource(code, {
        hardened: enforceLintHardening,
        globalAlias: enforceLintGlobalAlias
    }).errors.filter((e) => {
        if (e.rule === 'banned-async' && !enforceBannedAsync) return false;
        if (e.rule === 'banned-generator' && !enforceBannedGenerator) return false;
        if (e.rule === 'banned-wasm' && !enforceBannedWasm) return false;
        return CONSENSUS_RULES.has(e.rule);
    });
    if (blocking.length > 0)
        return { valid: false, error: blocking[0].message };

    return { valid: true };
}

/**
 * Scan contract code for patterns suggesting native float arithmetic.
 * Non-blocking warning; does not reject the contract.
 *
 * @param {string} code - Contract source code
 * @returns {string[]} Array of warning messages
 */
function checkFloatWarnings(code) {
    return findFloatWarnings(code).map((w) => w.message);
}

// findBannedMathCalls / findBannedLiterals moved to lint-core.js; re-exported
// here so existing callers of syntax.js keep working unchanged.
module.exports = { validateSyntax, checkFloatWarnings, findBannedMathCalls, findBannedLiterals, findBannedAsync, findBannedGenerator, findBannedWasm };
