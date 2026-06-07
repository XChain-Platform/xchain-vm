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
 * XChain VM — Sandbox
 *
 * Strips non-deterministic and dangerous APIs from the V8 isolate
 * context. Only safe, deterministic builtins survive.
 ********************************************************************/
// @ts-nocheck

// 


const ivm = require('isolated-vm');

// Script that runs inside the isolate to strip globals that can't
// be reached via setSync from the host (e.g., properties on existing objects)
const STRIP_SCRIPT = `
(function() {
    // Remove non-deterministic globals
    const toDelete = [
        'Date', 'setTimeout', 'setInterval', 'setImmediate',
        'clearTimeout', 'clearInterval', 'clearImmediate',
        'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect',
        'fetch', 'XMLHttpRequest', 'WebSocket',
        'SharedArrayBuffer', 'Atomics',
        'queueMicrotask',
        // BigInt arithmetic (** / *) is a native operation whose cost is super-linear
        // in operand size but is invisible to the AST gas meter -- e.g. 2n ** 5000000n
        // costs ~2 gas yet burns heavy CPU under the memory limit. Removed to close the
        // unmetered-CPU DoS surface; contracts use the metered xchain.math bignumber API
        // for large-number arithmetic. BigInt literals (10n) are rejected at deploy time
        // (see syntax.js) since a global delete cannot disable literal syntax.
        'BigInt',
        // Intl (ECMAScript 402) is locale-sensitive and its output depends on the
        // ICU data compiled into the host binary (full-icu vs small-icu, and the
        // ICU version that ships with each Node.js release). Two validators on
        // different Node.js/ICU builds would format the same value differently,
        // diverging state hashes across the fleet. Temporal and structuredClone
        // are stripped pre-emptively: Temporal exposes time-zone-sensitive output,
        // and structuredClone's serialization edge cases have varied across V8
        // versions — both are non-deterministic risks if a future V8 build exposes
        // them in the isolate.
        //
        // performance (the Web Performance API) is stripped for the same reason:
        // performance.now() returns wall-clock microseconds, a pure non-determinism
        // source equivalent to Date. A bare V8 isolate likely does not expose it
        // today, but V8 10.4+ ships a minimal performance stub for Wasm tooling that
        // may surface on newer host builds. The delete is a no-op if absent and a
        // critical guard if present, so it is stripped pre-emptively.
        'Intl', 'Temporal', 'structuredClone', 'performance'
    ];
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
    // Deleting the Intl global above does NOT disable these — they live on the
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

    // Remove console (replaced by xchain.log)
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
    // for sqrt — not for pow, log, log2, or log10 — so the host libm can differ
    // by 1 ULP in the last bit across CPU architectures (e.g. x86-64 vs ARM64).
    // A 1-ULP difference in a serialized result is enough to produce divergent
    // state hashes across a heterogeneous validator fleet, i.e. a consensus
    // split. Contracts that need these must use xchain.math.* (mathjs bignumber
    // — pure software arithmetic that is identical on every platform).
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
 */
function stripGlobals(isolate, context) {
    const script = isolate.compileScriptSync(STRIP_SCRIPT);
    script.runSync(context);
}

module.exports = { stripGlobals };
