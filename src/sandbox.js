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
 * XChain VM - Sandbox
 *
 * Strips non-deterministic and dangerous APIs from the V8 isolate
 * context. Only safe, deterministic builtins survive.
 ********************************************************************/
// @ts-nocheck

const ivm = require('isolated-vm');

// The canonical, FROZEN set of non-deterministic / dangerous global identifiers
// the sandbox deletes from the isolate. This is consensus-critical surface: a
// contract that reaches one of these can route a non-deterministic value into
// hashed state and fork the fleet, so the set is frozen with CONSENSUS_VERSION
// and digested by the determinism guard (test/determinism/consensus-params.test.js)
// Any add/remove must bump CONSENSUS_VERSION and re-golden in lockstep.
//
// Per-entry rationale:
//   - Date / timers (setTimeout, setInterval, setImmediate, clear*): wall-clock
//     and scheduling are pure non-determinism.
//   - WeakRef / FinalizationRegistry: GC-timing-observable.
//   - Proxy / Reflect: trap-based metering/identity escapes.
//   - fetch / XMLHttpRequest / WebSocket: network I/O.
//   - SharedArrayBuffer / Atomics: shared-memory / timing side channels.
//   - queueMicrotask + Promise: contracts run SYNCHRONOUSLY under the
//     CONTRACT_WRAPPER (runSync), so any microtask a contract schedules
//     (.then continuation, post-await write) drains on isolated-vm-version-
//     dependent timing that is outside the consensus pin, forking validators on
//     success-vs-timeout or post-await state. async/await/Promise are also
//     rejected at deploy time (lint-core findBannedAsync); stripping the Promise
//     global is defense in depth. The host still derives AsyncFunction below from
//     async-function syntax, which does not depend on the Promise global binding.
//     NOTE: the Promise strip is GATED on a block-time flag-day (see stripGlobals
//     opts.stripPromise) so a from-genesis replay reproduces the historical
//     pre-flag-day behaviour (Promise present); queueMicrotask was stripped from
//     the start and is NOT gated.
//   - BigInt: BigInt arithmetic (** / *) is a native operation whose cost is
//     super-linear in operand size but invisible to the AST gas meter -- e.g.
//     2n ** 5000000n costs ~2 gas yet burns heavy CPU under the memory limit.
//     Removed to close the unmetered-CPU DoS surface; contracts use the metered
//     xchain.math bignumber API. BigInt literals (10n) are rejected at deploy
//     time (syntax.js) since a global delete cannot disable literal syntax.
//   - Intl / Temporal / structuredClone / performance: Intl (ECMAScript 402) is
//     locale-sensitive and depends on the host ICU data; Temporal exposes
//     time-zone-sensitive output; structuredClone's serialization edge cases
//     have varied across V8 versions; performance.now() returns wall-clock
//     microseconds. All are non-deterministic risks (the deletes are no-ops if a
//     given build does not expose them, and critical guards if it does).
const STRIPPED_GLOBAL_NAMES = Object.freeze([
    'Date', 'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
    'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect',
    'fetch', 'XMLHttpRequest', 'WebSocket',
    'SharedArrayBuffer', 'Atomics',
    'queueMicrotask', 'Promise',
    'BigInt',
    'Intl', 'Temporal', 'structuredClone', 'performance'
]);

// Build the in-isolate strip script for a resolved identifier list. The list is
// decided HOST-side (stripGlobals), so a gated entry (e.g. Promise pre-flag-day)
// is simply absent from `names` and never deleted (exactly how a pre-activation
// node behaves). Everything after the toDelete loop is fixed neutering logic that
// does not depend on the list.
const buildStripScript = (names) => `
(function() {
    // Remove non-deterministic globals (host-resolved from STRIPPED_GLOBAL_NAMES;
    // gated entries the caller excludes are simply not present here).
    const toDelete = ${JSON.stringify(names)};
    for (const name of toDelete) {
        try { delete globalThis[name]; } catch(e) {}
        try { globalThis[name] = undefined; } catch(e) {}
    }

    // Block eval and Function constructor
    try { globalThis.eval = undefined; } catch(e) {}
    try {
        // Save a private reference for the contract wrapper to use
        globalThis.__Function = Function;
        globalThis.Function = undefined;

        // Neuter the constructor property on Function.prototype
        try { Object.defineProperty(globalThis.__Function.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}

        // Neuter GeneratorFunction, AsyncFunction, AsyncGeneratorFunction constructors.
        // These are separate function types with their own prototype chains.
        try {
            var GeneratorFunction = Object.getPrototypeOf(function*(){}).constructor;
            Object.defineProperty(GeneratorFunction.prototype, 'constructor', { value: undefined, writable: false, configurable: false });
            // Also kill GeneratorFunction itself if accessible
            try { Object.defineProperty(GeneratorFunction, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
        } catch(e) {}
        try {
            var AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            Object.defineProperty(AsyncFunction.prototype, 'constructor', { value: undefined, writable: false, configurable: false });
            try { Object.defineProperty(AsyncFunction, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
        } catch(e) {}
        try {
            var AsyncGeneratorFunction = Object.getPrototypeOf(async function*(){}).constructor;
            Object.defineProperty(AsyncGeneratorFunction.prototype, 'constructor', { value: undefined, writable: false, configurable: false });
            try { Object.defineProperty(AsyncGeneratorFunction, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
        } catch(e) {}
    } catch(e) {}

    // Neuter Object.prototype.constructor to prevent prototype chain traversal
    // e.g. ({}).__proto__.constructor('return process')()
    try { Object.defineProperty(Object.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}

    // Neuter Array/String/Number/Boolean/RegExp prototype constructors
    try { Object.defineProperty(Array.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
    try { Object.defineProperty(String.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
    try { Object.defineProperty(Number.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
    try { Object.defineProperty(Boolean.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}
    try { Object.defineProperty(RegExp.prototype, 'constructor', { value: undefined, writable: false, configurable: false }); } catch(e) {}

    // Neuter RegExp to prevent catastrophic backtracking (ReDoS)
    // Contracts should not need regex; string operations suffice.
    try { globalThis.RegExp = undefined; } catch(e) {}

    // Neuter locale/ICU-sensitive PROTOTYPE METHODS (consensus determinism).
    // Deleting the Intl global above does NOT disable these. They live on the
    // built-in prototypes and work without Intl. Their output depends on the ICU
    // data/version compiled into the host (which varies across Node.js/V8 builds),
    // so a contract that returns or stores their result would route an
    // ICU-version-dependent value into hashed state -> divergent Merkle root
    // across a heterogeneous validator fleet -> consensus fork. Neuter them so a
    // contract that calls one fails DETERMINISTICALLY (TypeError) instead.
    //   - String.prototype.normalize          (ICU normalization tables)
    //   - String.prototype.localeCompare       (ICU collation order/sign)
    //   - String.prototype.toLocaleLowerCase/UpperCase (locale case mapping)
    //   - Number/Array/Object.prototype.toLocaleString (locale separators)
    // Note: String.prototype.toLowerCase/toUpperCase are NOT neutered here. They are
    // non-locale methods whose Unicode case-folding output is pinned by the
    // 'unicode: 17.0' setting in consensus-runtime.js. This is analogous to the
    // e.message residual: covered by the runtime pin, not by prototype deletion.
    (function() {
        var locale = [
            [String.prototype, 'normalize'],
            [String.prototype, 'localeCompare'],
            [String.prototype, 'toLocaleLowerCase'],
            [String.prototype, 'toLocaleUpperCase'],
            [Number.prototype, 'toLocaleString'],
            [Array.prototype,  'toLocaleString'],
            [Object.prototype, 'toLocaleString']
        ];
        for (var i = 0; i < locale.length; i++) {
            try {
                Object.defineProperty(locale[i][0], locale[i][1],
                    { value: undefined, writable: false, configurable: false });
            } catch(e) {}
        }
    })();

    // Neuter Error stack traces (consensus determinism + info leak).
    // A contract can catch its own errors and return/store e.stack, which lands
    // in hashed state. V8's stack text is non-deterministic across builds and
    // leaks isolate-internal frame data: line/column offsets into the harness
    // wrapper (e.g. "<isolated-vm>:11:6"), frame formatting, and depth. All of
    // these change between V8 patch releases and whenever HARNESS_SOURCE is
    // edited. Force it to a constant: stackTraceLimit=0 plus a frozen
    // prepareStackTrace hook so every e.stack is the empty string, and lock both
    // so a contract cannot restore richer stacks. (NB: must run BEFORE
    // Object.defineProperty is stripped below.) The error MESSAGE text is a
    // V8-set own property on native throws and cannot be intercepted here; that
    // residual exposure is mitigated operationally by pinning the exact V8/ICU
    // build as a consensus parameter (see the cross-version determinism gate).
    try {
        Object.defineProperty(Error, 'stackTraceLimit', { value: 0, writable: false, configurable: false });
    } catch(e) {}
    try {
        Object.defineProperty(Error, 'prepareStackTrace', {
            value: function() { return ''; }, writable: false, configurable: false
        });
    } catch(e) {}

    // Save Object.defineProperty for the harness to use (it needs to lock __gas).
    // Store as a non-enumerable global so harness can access it, then harness deletes it.
    var _defineProperty = Object.defineProperty;
    var _freeze = Object.freeze;
    try {
        _defineProperty(globalThis, '__defineProperty', {
            value: _defineProperty,
            writable: false,
            configurable: true,  // harness will delete it after use
            enumerable: false
        });
    } catch(e) {}

    // Freeze Object.defineProperty/defineProperties to prevent getter/setter traps
    // that could execute unmetered code via property access
    try {
        _defineProperty(Object, 'defineProperty', { value: undefined, writable: false, configurable: false });
        _defineProperty(Object, 'defineProperties', { value: undefined, writable: false, configurable: false });
        // Also block Object.create with property descriptors (second argument)
        // Keep Object.create(null) working for prototype-free objects
        var _origCreate = Object.create;
        _defineProperty(Object, 'create', {
            value: function(proto) {
                if (arguments.length > 1) throw new Error('Object.create with property descriptors is not allowed');
                return _origCreate(proto);
            },
            writable: false,
            configurable: false
        });
    } catch(e) {}

    // Remove console (xchain.log is provided separately by the gateway)
    try { globalThis.console = undefined; } catch(e) {}

    // Remove process/require/import (shouldn't exist in isolate, but defensive)
    try { globalThis.process = undefined; } catch(e) {}
    try { globalThis.require = undefined; } catch(e) {}
    try { globalThis.importScripts = undefined; } catch(e) {}

    // Replace Math with a deterministic, architecture-independent subset.
    //
    // Math.random is omitted (non-deterministic).
    //
    // The transcendental functions (sqrt, pow, log, log2, log10) are also
    // INTENTIONALLY ABSENT. IEEE 754 only mandates correctly-rounded results
    // for sqrt, but not for pow, log, log2, or log10, so the host libm can differ
    // by 1 ULP in the last bit across CPU architectures (e.g. x86-64 vs ARM64).
    // A 1-ULP difference in a serialized result is enough to produce divergent
    // state hashes across a heterogeneous validator fleet, i.e. a consensus
    // split. Contracts that need these must use xchain.math.* (mathjs bignumber,
    // pure software arithmetic that is identical on every platform).
    //
    // The retained members (floor/ceil/round/abs/min/max/sign/trunc and the
    // PI/E constants) are exact, spec-defined operations with no rounding
    // ambiguity, so they are safe to expose directly.
    var SafeMath = {
        floor: Math.floor,
        ceil:  Math.ceil,
        round: Math.round,
        abs:   Math.abs,
        min:   Math.min,
        max:   Math.max,
        sign:  Math.sign,
        trunc: Math.trunc,
        PI:    Math.PI,
        E:     Math.E
    };
    globalThis.Math = _freeze(SafeMath);
})();
`;

/**
 * Strip non-deterministic APIs from the isolate context.
 * Must be called BEFORE injecting the gateway and __gas.
 * @param {ivm.Isolate} isolate
 * @param {ivm.Context} context
 * @param {object} [opts]
 * @param {boolean} [opts.stripPromise=false] - delete the global `Promise`.
 *        CONSENSUS-GATED on a block-time flag-day (see index.js): below the
 *        flag day (or for an un-gated/un-timestamped caller) Promise is LEFT
 *        IN PLACE, exactly as pre-activation nodes leave it, so a from-genesis
 *        replay reproduces the historical execution; at/after it Promise is
 *        stripped fleet-wide. queueMicrotask is always stripped (unchanged).
 */
function stripGlobals(isolate, context, opts) {
    const stripPromise = !!(opts && opts.stripPromise);
    const names = stripPromise
        ? STRIPPED_GLOBAL_NAMES
        : STRIPPED_GLOBAL_NAMES.filter((n) => n !== 'Promise');
    const script = isolate.compileScriptSync(buildStripScript(names));
    script.runSync(context);
}

module.exports = { stripGlobals, STRIPPED_GLOBAL_NAMES };
