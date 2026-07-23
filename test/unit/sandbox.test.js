// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// XChain VM: Sandbox tests
//
// Covers src/sandbox.js, the consensus-critical global/prototype strip that
// removes non-deterministic and dangerous APIs from every isolate before a
// contract runs. Written to kill the custom mutation-testing mutants the
// runner (test/mutation/stryker-xchain-vm-mutator) generates for this file
// (VM Finding-D, 2026-06-06 determinism/resource audit):
//   - ArrayElementDeletion on the four FROZEN lists (dropping any single entry
//     leaves a dangerous API reachable) -> the "must contain / exact length"
//     assertions below fail on any deletion.
//   - ObjectFreezeRemoval on the four Object.freeze(...) calls (an unfrozen
//     consensus list can be mutated at runtime) -> the Object.isFrozen checks
//     fail when the freeze is unwrapped.
// The isolate-execution block additionally proves the strip actually takes
// effect inside a real V8 isolate (behavioural defence-in-depth). isolated-vm
// dlopens fail on macOS, so that block runs only where the native binding
// loads (devhost / Linux node:22); the require is guarded so a macOS run
// skips loudly-but-cleanly instead of crash-spamming.

const assert = require('assert');

let sandbox, IsolateManager, ivm;
try {
    sandbox = require('../../src/sandbox.js');
    IsolateManager = require('../../src/isolate.js');
    ivm = require('isolated-vm');
} catch (e) {
    console.log('Skipping sandbox tests (isolated-vm not available):',
        e.message.split('\n')[0]);
}

const {
    STRIPPED_GLOBAL_NAMES,
    STRIPPED_PROTO_METHODS,
    NEUTERED_PROTO_CONSTRUCTORS,
    SAFE_MATH_MEMBERS,
    stripGlobals
} = sandbox || {};

// The canonical membership each frozen list MUST carry. Kept as an independent
// copy here (not derived from the module under test) so a mutation that drops
// or reorders an entry is caught by a fixed expectation, not a tautology.
const EXPECTED_GLOBAL_NAMES = [
    'Date', 'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
    'WeakRef', 'FinalizationRegistry', 'Proxy', 'Reflect',
    'fetch', 'XMLHttpRequest', 'WebSocket',
    'SharedArrayBuffer', 'Atomics',
    'queueMicrotask', 'Promise',
    'BigInt',
    'WebAssembly',
    'Intl', 'Temporal', 'structuredClone', 'performance'
];

const EXPECTED_PROTO_METHODS = [
    { proto: 'String', method: 'match' },
    { proto: 'String', method: 'matchAll' },
    { proto: 'String', method: 'search' },
    { proto: 'String', method: 'normalize' },
    { proto: 'String', method: 'localeCompare' },
    { proto: 'String', method: 'toLocaleLowerCase' },
    { proto: 'String', method: 'toLocaleUpperCase' },
    { proto: 'Number', method: 'toLocaleString' },
    { proto: 'Array', method: 'toLocaleString' },
    { proto: 'Object', method: 'toLocaleString' }
];

const EXPECTED_NEUTERED_CTORS = [
    'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp'
];

const EXPECTED_SAFE_MATH = [
    'floor', 'ceil', 'round', 'abs', 'min', 'max', 'sign', 'trunc', 'PI', 'E'
];

// Members that MUST NOT be in the safe Math subset (non-deterministic /
// cross-arch-divergent). Guards against a mutation that widens the whitelist.
const FORBIDDEN_SAFE_MATH = [
    'random', 'sqrt', 'pow', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'exp'
];

(sandbox ? describe : describe.skip)('sandbox: frozen consensus lists', function() {

    describe('STRIPPED_GLOBAL_NAMES', function() {
        it('is a frozen array', function() {
            assert(Array.isArray(STRIPPED_GLOBAL_NAMES));
            assert(Object.isFrozen(STRIPPED_GLOBAL_NAMES),
                'STRIPPED_GLOBAL_NAMES must be frozen (consensus-critical)');
        });
        it('contains every expected non-deterministic global', function() {
            for (const name of EXPECTED_GLOBAL_NAMES) {
                assert(STRIPPED_GLOBAL_NAMES.includes(name),
                    'missing stripped global: ' + name);
            }
        });
        it('carries exactly the expected entries (no additions/removals)', function() {
            assert.strictEqual(STRIPPED_GLOBAL_NAMES.length, EXPECTED_GLOBAL_NAMES.length,
                'length drift: any element deletion/addition is a consensus change');
            assert.deepStrictEqual(
                [...STRIPPED_GLOBAL_NAMES].sort(),
                [...EXPECTED_GLOBAL_NAMES].sort());
        });
        it('has no duplicate entries', function() {
            assert.strictEqual(
                new Set(STRIPPED_GLOBAL_NAMES).size, STRIPPED_GLOBAL_NAMES.length);
        });
    });

    describe('STRIPPED_PROTO_METHODS', function() {
        it('is a frozen array', function() {
            assert(Array.isArray(STRIPPED_PROTO_METHODS));
            assert(Object.isFrozen(STRIPPED_PROTO_METHODS));
        });
        it('contains every expected {proto, method} neuter', function() {
            for (const exp of EXPECTED_PROTO_METHODS) {
                const found = STRIPPED_PROTO_METHODS.some(
                    (m) => m.proto === exp.proto && m.method === exp.method);
                assert(found, 'missing proto-method neuter: ' + exp.proto + '.' + exp.method);
            }
        });
        it('carries exactly the expected count', function() {
            assert.strictEqual(
                STRIPPED_PROTO_METHODS.length, EXPECTED_PROTO_METHODS.length);
        });
        it('includes the ReDoS-coercion methods (match/matchAll/search)', function() {
            for (const m of ['match', 'matchAll', 'search']) {
                assert(STRIPPED_PROTO_METHODS.some(
                    (e) => e.proto === 'String' && e.method === m),
                    'String.' + m + ' must be neutered (RegExp coercion / ReDoS)');
            }
        });
    });

    describe('NEUTERED_PROTO_CONSTRUCTORS', function() {
        it('is a frozen array', function() {
            assert(Array.isArray(NEUTERED_PROTO_CONSTRUCTORS));
            assert(Object.isFrozen(NEUTERED_PROTO_CONSTRUCTORS));
        });
        it('contains every expected prototype whose constructor is neutered', function() {
            for (const name of EXPECTED_NEUTERED_CTORS) {
                assert(NEUTERED_PROTO_CONSTRUCTORS.includes(name),
                    'missing neutered proto-constructor: ' + name);
            }
        });
        it('carries exactly the expected entries', function() {
            assert.strictEqual(
                NEUTERED_PROTO_CONSTRUCTORS.length, EXPECTED_NEUTERED_CTORS.length);
            assert.deepStrictEqual(
                [...NEUTERED_PROTO_CONSTRUCTORS].sort(),
                [...EXPECTED_NEUTERED_CTORS].sort());
        });
    });

    describe('SAFE_MATH_MEMBERS', function() {
        it('is a frozen array', function() {
            assert(Array.isArray(SAFE_MATH_MEMBERS));
            assert(Object.isFrozen(SAFE_MATH_MEMBERS));
        });
        it('contains every expected exact/spec-defined Math member', function() {
            for (const name of EXPECTED_SAFE_MATH) {
                assert(SAFE_MATH_MEMBERS.includes(name),
                    'missing safe Math member: ' + name);
            }
        });
        it('carries exactly the expected entries', function() {
            assert.strictEqual(SAFE_MATH_MEMBERS.length, EXPECTED_SAFE_MATH.length);
            assert.deepStrictEqual(
                [...SAFE_MATH_MEMBERS].sort(),
                [...EXPECTED_SAFE_MATH].sort());
        });
        it('excludes the non-deterministic / cross-arch transcendentals', function() {
            for (const name of FORBIDDEN_SAFE_MATH) {
                assert(!SAFE_MATH_MEMBERS.includes(name),
                    name + ' must NOT be in the safe Math subset');
            }
        });
    });
});

// ─── stripGlobals: host-side name selection (Promise flag-day gate) ──────────
//
// stripGlobals decides the deletion list HOST-side, then compiles+runs a strip
// script. A mock isolate captures that script text without needing the native
// binding, so the Promise-gating branch logic is exercised directly. This kills
// mutants on the `stripPromise` ternary and the `!== 'Promise'` filter.

(sandbox ? describe : describe.skip)('sandbox: stripGlobals name selection', function() {

    function captureToDelete(opts) {
        let captured = null;
        const mockIsolate = {
            compileScriptSync(src) { captured = src; return { runSync() {} }; }
        };
        stripGlobals(mockIsolate, {}, opts);
        assert(captured, 'stripGlobals should have compiled a strip script');
        const m = captured.match(/const toDelete = (\[[\s\S]*?\]);/);
        assert(m, 'strip script should embed a toDelete array literal');
        return JSON.parse(m[1]);
    }

    it('compiles and runs the strip script exactly once', function() {
        let compiled = 0, ran = 0;
        const mockIsolate = {
            compileScriptSync() { compiled++; return { runSync() { ran++; } }; }
        };
        stripGlobals(mockIsolate, {});
        assert.strictEqual(compiled, 1);
        assert.strictEqual(ran, 1);
    });

    it('omits Promise from the deletion list by default (pre-flag-day replay)', function() {
        const list = captureToDelete(undefined);
        assert(!list.includes('Promise'),
            'Promise must be LEFT IN PLACE when stripPromise is not set');
    });

    it('omits Promise when stripPromise is explicitly false', function() {
        const list = captureToDelete({ stripPromise: false });
        assert(!list.includes('Promise'));
    });

    it('omits Promise for an empty opts object', function() {
        const list = captureToDelete({});
        assert(!list.includes('Promise'));
    });

    it('includes Promise only when stripPromise is true (at/after flag-day)', function() {
        const list = captureToDelete({ stripPromise: true });
        assert(list.includes('Promise'),
            'Promise must be stripped when stripPromise is true');
    });

    it('always strips queueMicrotask regardless of the Promise gate', function() {
        assert(captureToDelete(undefined).includes('queueMicrotask'));
        assert(captureToDelete({ stripPromise: true }).includes('queueMicrotask'));
    });

    // WebAssembly is a second gated entry (flag-day Pkg 3, ): left in place
    // by default, stripped only when stripWasm is true, exactly like Promise.
    it('omits WebAssembly from the deletion list by default (pre-flag-day replay)', function() {
        assert(!captureToDelete(undefined).includes('WebAssembly'),
            'WebAssembly must be LEFT IN PLACE when stripWasm is not set');
        assert(!captureToDelete({}).includes('WebAssembly'));
        assert(!captureToDelete({ stripWasm: false }).includes('WebAssembly'));
    });

    it('includes WebAssembly only when stripWasm is true (at/after the Pkg 3 flag-day)', function() {
        assert(captureToDelete({ stripWasm: true }).includes('WebAssembly'),
            'WebAssembly must be stripped when stripWasm is true');
    });

    it('the two gated entries are independent (Promise and WebAssembly gate separately)', function() {
        assert(!captureToDelete({ stripPromise: true }).includes('WebAssembly'),
            'stripPromise must not strip WebAssembly');
        assert(!captureToDelete({ stripWasm: true }).includes('Promise'),
            'stripWasm must not strip Promise');
    });

    it('default list is the full frozen set minus the gated entries (Promise, WebAssembly)', function() {
        const list = captureToDelete(undefined);
        const expected = EXPECTED_GLOBAL_NAMES.filter((n) => n !== 'Promise' && n !== 'WebAssembly');
        assert.deepStrictEqual(list.sort(), expected.sort());
    });

    it('both gates on -> list is exactly the full frozen set', function() {
        const list = captureToDelete({ stripPromise: true, stripWasm: true });
        assert.deepStrictEqual(list.sort(), [...EXPECTED_GLOBAL_NAMES].sort());
    });
});

// ─── Behavioural: strip actually takes effect inside a real isolate ──────────
//
// Requires the native binding, so guarded on ivm availability (macOS skips).

(sandbox && ivm && IsolateManager ? describe : describe.skip)(
    'sandbox: strip enforced inside a live isolate', function() {

    this.timeout(30000);

    // Run `expr` inside a fresh, stripped isolate and return its value.
    function evalStripped(expr, opts) {
        const mgr = new IsolateManager({ maxMemory: 8 });
        const { isolate, context } = mgr.createIsolate();
        try {
            stripGlobals(isolate, context, opts);
            return isolate.compileScriptSync(expr).runSync(context);
        } finally {
            mgr.dispose(isolate);
        }
    }

    it('removes every ungated global in the strip list (Promise + WebAssembly are gated)', function() {
        const names = EXPECTED_GLOBAL_NAMES.filter((n) => n !== 'Promise' && n !== 'WebAssembly');
        const leftover = evalStripped(
            JSON.stringify(names) +
            '.filter(function(n){return typeof globalThis[n] !== "undefined";}).join(",")');
        assert.strictEqual(leftover, '', 'still-reachable globals: ' + leftover);
    });

    it('leaves WebAssembly in place by default but strips it when gated', function() {
        assert.strictEqual(evalStripped('typeof globalThis.WebAssembly'), 'object');
        assert.strictEqual(
            evalStripped('typeof globalThis.WebAssembly', { stripWasm: true }), 'undefined');
    });

    it('leaves Promise in place by default but strips it when gated', function() {
        assert.strictEqual(evalStripped('typeof globalThis.Promise'), 'function');
        assert.strictEqual(
            evalStripped('typeof globalThis.Promise', { stripPromise: true }), 'undefined');
    });

    it('removes eval, the Function constructor and RegExp', function() {
        assert.strictEqual(evalStripped('typeof globalThis.eval'), 'undefined');
        assert.strictEqual(evalStripped('typeof globalThis.Function'), 'undefined');
        assert.strictEqual(evalStripped('typeof globalThis.RegExp'), 'undefined');
    });

    it('neuters .constructor on every built-in prototype', function() {
        const out = evalStripped(
            '[({}).constructor, [].constructor, "".constructor, (0).constructor, (true).constructor]' +
            '.every(function(c){return c === undefined;})');
        assert.strictEqual(out, true, 'a prototype .constructor is still reachable (escape risk)');
    });

    it('blocks the classic prototype-chain escape to a Function constructor', function() {
        const out = evalStripped(
            '(function(){try{ ({}).constructor.constructor("return 1")(); return "escaped"; }' +
            'catch(e){ return "blocked"; }})()');
        assert.strictEqual(out, 'blocked');
    });

    it('neuters the ReDoS-coercion and locale/ICU prototype methods', function() {
        assert.strictEqual(evalStripped('typeof "abc".match'), 'undefined');
        assert.strictEqual(evalStripped('typeof "abc".matchAll'), 'undefined');
        assert.strictEqual(evalStripped('typeof "abc".search'), 'undefined');
        assert.strictEqual(evalStripped('typeof "abc".normalize'), 'undefined');
        assert.strictEqual(evalStripped('typeof "abc".localeCompare'), 'undefined');
        assert.strictEqual(evalStripped('typeof (5).toLocaleString'), 'undefined');
    });

    it('replaces Math with a frozen deterministic subset', function() {
        assert.strictEqual(evalStripped('Object.isFrozen(Math)'), true);
        // Retained exact members work.
        assert.strictEqual(evalStripped('Math.floor(3.9)'), 3);
        assert.strictEqual(evalStripped('typeof Math.abs'), 'function');
        assert(evalStripped('Math.PI > 3.14 && Math.PI < 3.15'));
        // Non-deterministic members are gone.
        for (const m of FORBIDDEN_SAFE_MATH) {
            assert.strictEqual(evalStripped('typeof Math.' + m), 'undefined',
                'Math.' + m + ' must be absent from the safe subset');
        }
    });

    it('removes Object.defineProperty/defineProperties and descriptor-form create', function() {
        assert.strictEqual(evalStripped('typeof Object.defineProperty'), 'undefined');
        assert.strictEqual(evalStripped('typeof Object.defineProperties'), 'undefined');
        // Object.create(null) still works (prototype-free objects), but the
        // descriptor form is rejected.
        assert.strictEqual(evalStripped('typeof Object.create(null)'), 'object');
        assert.strictEqual(evalStripped(
            '(function(){try{ Object.create({}, {x:{value:1}}); return "allowed"; }' +
            'catch(e){ return "rejected"; }})()'), 'rejected');
    });

    it('removes console, process and require', function() {
        assert.strictEqual(evalStripped('typeof globalThis.console'), 'undefined');
        assert.strictEqual(evalStripped('typeof globalThis.process'), 'undefined');
        assert.strictEqual(evalStripped('typeof globalThis.require'), 'undefined');
    });

    it('forces empty error stacks (determinism + info-leak defense)', function() {
        const stack = evalStripped(
            '(function(){try{ throw new Error("x"); }catch(e){ return String(e.stack); }})()');
        assert.strictEqual(stack, '');
    });
});
