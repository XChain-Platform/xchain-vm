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
 * XChain VM: sandbox stripped-global names - THE SINGLE SOURCE OF TRUTH
 *
 * The FROZEN set of non-deterministic / dangerous global identifiers the
 * sandbox deletes from the isolate, plus the two derived views of it the rest
 * of the tree needs. Consensus-critical surface: a contract that reaches one of
 * these can route a non-deterministic value into hashed state and fork the
 * fleet, so the set is frozen with CONSENSUS_VERSION and digested by the
 * determinism guard (test/determinism/consensus-params.test.js). Any add or
 * remove must bump CONSENSUS_VERSION and re-golden in lockstep.
 *
 * WHY THIS FILE EXISTS. Three consumers need these names and only one of them
 * can load the isolate:
 *   - sandbox.js builds the strip script (requires isolated-vm),
 *   - lint-core.js warns on a contract that reads one (must run in the SDK and
 *     in a browser, where no isolate exists),
 *   - toolkit/authoring.js teaches them to a model (deliberately isolate-free
 *     so the authoring loop runs on any OS).
 * Each of them used to carry its own hand-copied literal held equal only by
 * parity tests that SKIP wherever the isolated-vm binding will not load, which
 * is exactly where the copies are consumed. This module is the one definition
 * all three require instead.
 *
 * THIS FILE IS DEPENDENCY-FREE AND VENDORED. xchain-sdk keeps a byte-identical
 * copy at src/contract/stripped-globals.js so lint-core.js can reach it with
 * ONE require line - './stripped-globals.js' - that resolves in both trees
 * (lint-core.js itself is byte-identity-locked across the two repos). It must
 * therefore require nothing: any dependency would have to resolve at two
 * different relative depths. Edit here, then re-sync the vendored copy in the
 * SAME change; a sha256 parity guard fails the build on drift.
 *
 * Per-entry rationale:
 *   - Date / timers (setTimeout, setInterval, setImmediate, clear*): wall-clock
 *     and scheduling are pure non-determinism.
 *   - WeakRef / FinalizationRegistry: GC-timing-observable.
 *   - Proxy / Reflect: trap-based metering/identity escapes.
 *   - fetch / XMLHttpRequest / WebSocket: network I/O.
 *   - SharedArrayBuffer / Atomics: shared-memory / timing side channels.
 *   - queueMicrotask + Promise: contracts run SYNCHRONOUSLY under the
 *     CONTRACT_WRAPPER (runSync), so any microtask a contract schedules
 *     (.then continuation, post-await write) drains on isolated-vm-version-
 *     dependent timing that is outside the consensus pin, forking validators on
 *     success-vs-timeout or post-await state. async/await/Promise are also
 *     rejected at deploy time (lint-core findBannedAsync); stripping the Promise
 *     global is defense in depth. The host still derives AsyncFunction from
 *     async-function syntax, which does not depend on the Promise global binding.
 *     NOTE: the Promise strip is GATED on a block-time flag-day (sandbox.js
 *     stripGlobals opts.stripPromise) so a from-genesis replay reproduces the
 *     historical pre-flag-day behaviour (Promise present); queueMicrotask was
 *     stripped from the start and is NOT gated.
 *   - BigInt: BigInt arithmetic (** / *) is a native operation whose cost is
 *     super-linear in operand size but invisible to the AST gas meter -- e.g.
 *     2n ** 5000000n costs ~2 gas yet burns heavy CPU under the memory limit.
 *     Removed to close the unmetered-CPU DoS surface; contracts use the metered
 *     xchain.math bignumber API. BigInt literals (10n) are rejected at deploy
 *     time (syntax.js) since a global delete cannot disable literal syntax.
 *   - WebAssembly (flag-day Pkg 3, 75190596): a core V8 global reachable from
 *     contract code. A wasm body carries NO __gas instrumentation (the AST meter
 *     only touches the JS source), so WebAssembly.instantiate/compile/Module/
 *     Instance runs unmetered native code under the memory limit -- the same
 *     unmetered-CPU DoS class as BigInt, plus a consensus-fork surface (a wasm
 *     trap / float result observed and routed into hashed state can diverge
 *     across builds). Stripping the global closes it deterministically. GATED on
 *     the per-coin Pkg 3 bundle height flag-day (index.js isPkg3SandboxActive,
 *     threaded as stripGlobals opts.stripWasm), exactly like Promise: below the
 *     flag day WebAssembly is LEFT IN PLACE so a from-genesis replay reproduces
 *     the historical execution; at/after it the global is absent fleet-wide.
 *     (The companion deploy-lint ban is gated indexer-side via validateSyntax
 *     enforce-flags and is tracked separately; this runtime strip is the
 *     load-bearing consensus fix.)
 *   - Intl / Temporal / structuredClone / performance: Intl (ECMAScript 402) is
 *     locale-sensitive and depends on the host ICU data; Temporal exposes
 *     time-zone-sensitive output; structuredClone's serialization edge cases
 *     have varied across V8 versions; performance.now() returns wall-clock
 *     microseconds. All are non-deterministic risks (the deletes are no-ops if a
 *     given build does not expose them, and critical guards if it does).
 ********************************************************************/
// @ts-nocheck

const STRIPPED_GLOBAL_NAMES = Object.freeze([
    'Date', 'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
    'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect',
    'fetch', 'XMLHttpRequest', 'WebSocket',
    'SharedArrayBuffer', 'Atomics',
    'queueMicrotask', 'Promise',
    'BigInt',
    'WebAssembly',
    'Intl', 'Temporal', 'structuredClone', 'performance'
]);

// The entries whose strip is CONSENSUS-GATED on a flag day (see the Promise and
// WebAssembly notes above): below their activation the sandbox leaves the global
// in place so a from-genesis replay reproduces the historical execution.
// "The sandbox deletes it, so this throws at runtime" is therefore NOT
// unconditionally true for these two, which is what the advisory view below
// turns on. Both already carry an unconditional ERROR-severity lint rule
// (banned-async, banned-wasm).
const CONSENSUS_GATED_STRIPPED_GLOBALS = Object.freeze(['Promise', 'WebAssembly']);

// The subset a dependency-light linter may WARN on unconditionally: every name
// stripped from genesis on every network. Holding the two gated names out loses
// no signal (their error-severity rules fire regardless of the runtime gate) and
// avoids double-reporting one line. BigInt stays IN: the banned-literal rule
// covers only the `2n` literal form, so `BigInt("1")` lints clean today while
// throwing at runtime.
const ADVISORY_STRIPPED_GLOBAL_NAMES = Object.freeze(
    STRIPPED_GLOBAL_NAMES.filter((n) => CONSENSUS_GATED_STRIPPED_GLOBALS.indexOf(n) === -1)
);

module.exports = {
    STRIPPED_GLOBAL_NAMES,
    CONSENSUS_GATED_STRIPPED_GLOBALS,
    ADVISORY_STRIPPED_GLOBAL_NAMES
};
