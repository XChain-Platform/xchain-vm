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

// The canonical, FROZEN set of consensus-critical PROTOTYPE-METHOD neuters the
// sandbox replaces with `undefined`. Deleting a global (above) is NOT enough for
// these: they live on built-in prototypes and stay reachable. Each entry names the
// owning intrinsic (resolved to its `.prototype` inside the isolate) and the method
// to neuter. This list is the single source of truth that buildStripScript
// interpolates, and it is frozen + digested by the determinism guard
// (test/determinism/consensus-params.test.js) exactly like STRIPPED_GLOBAL_NAMES;
// any add/remove is a consensus change that must update both repos' goldens.
//
// Two categories, same fork risk:
//   - REGEX methods (match/matchAll/search): coerce a string argument to a RegExp
//     via the %RegExp% intrinsic, so a "(a+)+$"-style ReDoS still runs through them
//     even after the RegExp global is deleted, for ~1 gas while burning unbounded
//     wall-clock. Gas counts ops, not backtracking steps, so a slow validator times
//     out where a fast one commits -> wall-clock-dependent divergence.
//   - LOCALE/ICU methods (normalize/localeCompare/toLocale*): their output depends
//     on the host ICU data/version, which varies across builds, so a stored result
//     routes an ICU-version-dependent value into hashed state -> divergent Merkle
//     root across a heterogeneous fleet.
// Both are hard-neutered so a contract that calls one fails DETERMINISTICALLY
// (TypeError). NB: String.prototype.toLowerCase/toUpperCase are deliberately NOT
// here; their Unicode case-folding is pinned by 'unicode: 17.0' in
// consensus-runtime.js, the same way the e.message residual is covered by the pin.
const STRIPPED_PROTO_METHODS = Object.freeze([
    { proto: 'String', method: 'match' },
    { proto: 'String', method: 'matchAll' },
    { proto: 'String', method: 'search' },
    { proto: 'String', method: 'normalize' },
    { proto: 'String', method: 'localeCompare' },
    { proto: 'String', method: 'toLocaleLowerCase' },
    { proto: 'String', method: 'toLocaleUpperCase' },
    { proto: 'Number', method: 'toLocaleString' },
    { proto: 'Array',  method: 'toLocaleString' },
    { proto: 'Object', method: 'toLocaleString' }
]);

// The FROZEN set of built-in prototypes whose `.constructor` is neutered to block
// prototype-chain escapes (e.g. ({}).__proto__.constructor('return process')()).
// Same consensus-critical / frozen / digested treatment as the lists above.
const NEUTERED_PROTO_CONSTRUCTORS = Object.freeze([
    'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp'
]);

// The FROZEN whitelist of Math members the deterministic SafeMath subset exposes.
// Math.random and the transcendentals (sqrt/pow/log/log2/log10) are intentionally
// ABSENT (non-deterministic / up-to-1-ULP cross-arch differences); contracts use
// xchain.math.* instead. The retained members are exact, spec-defined operations
// with no rounding ambiguity. Frozen + digested so adding/removing one is a
// consensus change.
const SAFE_MATH_MEMBERS = Object.freeze([
    'floor', 'ceil', 'round', 'abs', 'min', 'max', 'sign', 'trunc', 'PI', 'E'
]);

// Build the in-isolate strip script for a resolved identifier list. The list is
// decided HOST-side (stripGlobals), so a gated entry (e.g. Promise pre-flag-day)
// is simply absent from `names` and never deleted (exactly how a pre-activation
// node behaves). Everything after the toDelete loop is fixed neutering logic that
// does not depend on the list.
const buildStripScript = (names) => `
(function() {
    // Capture built-in prototype references ONCE, up front, before any global is
    // deleted (RegExp's global is removed further down). Both neuter loops below
    // resolve their target proto through this single six-key map. Fail-closed: an
    // entry in NEUTERED_PROTO_CONSTRUCTORS or STRIPPED_PROTO_METHODS naming a proto
    // absent here THROWS and aborts sandbox setup, rather than silently no-opping
    // while the consensus-params freeze guard (which digests only list membership)
    // stays green and certifies a neuter that never ran (item 5309).
    var _PROTOS = {
        Object: Object.prototype, Array: Array.prototype, String: String.prototype,
        Number: Number.prototype, Boolean: Boolean.prototype, RegExp: RegExp.prototype
    };

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

    // Neuter the .constructor on built-in prototypes to prevent prototype-chain
    // traversal, e.g. ({}).__proto__.constructor('return process')(). The target
    // set is the frozen NEUTERED_PROTO_CONSTRUCTORS (host-interpolated), resolved
    // through the up-front _PROTOS map.
    (function() {
        var ctorTargets = ${JSON.stringify(NEUTERED_PROTO_CONSTRUCTORS)};
        for (var i = 0; i < ctorTargets.length; i++) {
            var proto = _PROTOS[ctorTargets[i]];
            // Fail-closed: an unmapped proto name aborts setup (see _PROTOS note).
            if (!proto) throw new Error('NEUTERED_PROTO_CONSTRUCTORS: unmapped proto ' + ctorTargets[i]);
            try {
                Object.defineProperty(proto, 'constructor',
                    { value: undefined, writable: false, configurable: false });
            } catch(e) {}
        }
    })();

    // Neuter RegExp to prevent catastrophic backtracking (ReDoS)
    // Contracts should not need regex; string operations suffice.
    try { globalThis.RegExp = undefined; } catch(e) {}

    // Neuter consensus-critical PROTOTYPE METHODS (regex coercion + locale/ICU).
    // Deleting the RegExp/Intl globals above does NOT disable these: they live on
    // the built-in prototypes and stay reachable. The frozen STRIPPED_PROTO_METHODS
    // list (host-interpolated) is the single source of truth; see its definition
    // for the per-category rationale (ReDoS via %RegExp% coercion that gas metering
    // cannot see; ICU-version-dependent output). Hard-neutered so a contract that
    // calls one fails DETERMINISTICALLY (TypeError).
    (function() {
        var protoMethods = ${JSON.stringify(STRIPPED_PROTO_METHODS)};
        for (var i = 0; i < protoMethods.length; i++) {
            var proto = _PROTOS[protoMethods[i].proto];
            // Fail-closed: an unmapped proto name aborts setup rather than leaving
            // the method reachable while the freeze guard greens (item 5309).
            if (!proto) throw new Error('STRIPPED_PROTO_METHODS: unmapped proto ' + protoMethods[i].proto);
            try {
                Object.defineProperty(proto, protoMethods[i].method,
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
    // SafeMath is built from the frozen SAFE_MATH_MEMBERS whitelist (host-
    // interpolated) so the exposed member set is the single source of truth the
    // determinism guard digests. Each name is copied straight off the native Math.
    var SafeMath = (function() {
        var m = {};
        var members = ${JSON.stringify(SAFE_MATH_MEMBERS)};
        for (var i = 0; i < members.length; i++) { m[members[i]] = Math[members[i]]; }
        return m;
    })();
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

module.exports = {
    stripGlobals,
    STRIPPED_GLOBAL_NAMES,
    STRIPPED_PROTO_METHODS,
    NEUTERED_PROTO_CONSTRUCTORS,
    SAFE_MATH_MEMBERS
};
