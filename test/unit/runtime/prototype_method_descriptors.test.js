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
//
// Metered-source cache. meterCode() is the most expensive step of a
// The XChainVM class file is split into part modules under src/index/ whose
// methods are put back on the prototype by installMethods. Class-body methods
// are non-enumerable; Object.assign would have made the moved ones enumerable,
// so for...in over a VM instance and Object.keys of the prototype would have
// started listing them. This pins the prototype's descriptor rows and the
// constructor's static export table (name, order, flags, type, arity) to the
// reading taken from the unsplit class, so a split can never move the surface.

const assert = require('assert');
const XChainVM = require('../../../src/index.js');
// Required lazily so the descriptor cases above it still run against a tree
// that predates the installer.
const installMethods = (...args) => require('../../../src/index/install_methods.js').installMethods(...args);

// [key, enumerable, writable, configurable, typeof, function length], sorted
// by key. Read from the unsplit class file.
const BASE_PROTOTYPE_ROWS = [
    ["beginBlock", false, true, true, "function", 0],
    ["checkFloatWarnings", false, true, true, "function", 1],
    ["classifyError", false, true, true, "function", 6],
    ["constructor", false, true, true, "function", 1],
    ["endBlock", false, true, true, "function", 0],
    ["errorResult", false, true, true, "function", 4],
    ["execute", false, true, true, "function", 1],
    ["getLintVerdict", false, true, true, "function", 7],
    ["getMeteredCode", false, true, true, "function", 5],
    ["injectGateway", false, true, true, "function", 2],
    ["readManifest", false, true, true, "function", 2],
    ["sanitizeError", false, true, true, "function", 1],
    ["shutdown", false, true, true, "function", 0],
    ["validateSyntax", false, true, true, "function", 2],
    ["wallClockBudgetMs", false, true, true, "function", 1],
];

// The statics module.exports attaches to the constructor, in attachment order
// (src/toolkit/simulator.js reads that order through Object.keys). Same row
// shape; length, name and prototype are the function's own.
const BASE_STATIC_ROWS = [
    ["MAX_CODE_SIZE", true, true, true, "number", null],
    ["MAX_CALL_DEPTH", true, true, true, "number", null],
    ["MIN_CALL_GAS", true, true, true, "number", null],
    ["MAX_STACK_DEPTH", true, true, true, "number", null],
    ["MAX_STACK_DEPTH_MUSL", true, true, true, "number", null],
    ["PKG3_SANDBOX_ACTIVATION", true, true, true, "object", null],
    ["isPkg3SandboxActive", true, true, true, "function", 3],
    ["pkg3CoinFromAddress", true, true, true, "function", 1],
    ["EXEC_LINT_ACTIVATION", true, true, true, "object", null],
    ["isExecLintActive", true, true, true, "function", 3],
    ["EXEC_LINT_GAS_BYTES_PER_UNIT", true, true, true, "number", null],
    ["LINT_GLOBAL_ALIAS_ACTIVATION", true, true, true, "object", null],
    ["isLintGlobalAliasActive", true, true, true, "function", 3],
    ["BINARY_ALLOC_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["ASYNC_SURFACE_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["isAsyncSurfaceActive", true, true, true, "function", 2],
    ["STATE_KEY_NUL_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["METERING_EVAL_ORDER_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["CALL_SPREAD_METER_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["REST_PATTERN_METER_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["isRestPatternMeterActive", true, true, true, "function", 2],
    ["STATE_KEY_TYPE_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["VM_LINT_HARDENING_GATE_BLOCK_TIME", true, true, true, "number", null],
    ["isLintHardeningActive", true, true, true, "function", 2],
    ["CONSENSUS_MAX_WALL_MS", true, true, true, "number", null],
    ["isConsensusWallClockActive", true, true, true, "function", 2],
    ["isSlashTokenDelimGuardActive", true, true, true, "function", 2],
    ["isSlashAmountPrecisionActive", true, true, true, "function", 2],
    ["MAX_SLASH_AMOUNT_DECIMALS", true, true, true, "number", null],
    ["XCALL_MIN_GAS", true, true, true, "number", null],
    ["XCALL_MAX_GAS", true, true, true, "number", null],
    ["XCALL_MAX_HOPS", true, true, true, "number", null],
    ["XCALL_MIN_DEADLINE_BLOCKS", true, true, true, "number", null],
    ["XCALL_MAX_DEADLINE_BLOCKS", true, true, true, "number", null],
    ["XCALL_MAX_RETURN_BYTES", true, true, true, "number", null],
    ["CONSENSUS_RUNTIME", true, true, true, "object", null],
    ["CONSENSUS_VERSION", true, true, true, "string", null],
    ["CONSENSUS_STATUS_TOKENS", true, true, true, "object", null],
    ["STATUS_ERROR_PREFIXES", true, true, true, "object", null],
    ["checkConsensusRuntime", true, true, true, "function", 1],
    ["describeRuntimeMismatch", true, true, true, "function", 1],
    ["HostFaultError", true, true, true, "function", 1],
    ["STRIPPED_GLOBAL_NAMES", true, true, true, "object", null],
    ["CONSENSUS_RULES", true, true, true, "object", null],
    ["STRIPPED_PROTO_METHODS", true, true, true, "object", null],
    ["NEUTERED_PROTO_CONSTRUCTORS", true, true, true, "object", null],
    ["SAFE_MATH_MEMBERS", true, true, true, "object", null],
];

// The constructor sets this flag on itself the first time an embedder omits
// the execution mode, so whether it exists depends on what ran earlier in the
// process; it is not part of the exported surface.
const LAZY_STATICS = ['_warnedImplicitInProcess'];

function row(obj, k) {
    const x = Object.getOwnPropertyDescriptor(obj, k);
    const v = x.value;
    return [k, x.enumerable, 'writable' in x ? x.writable : null, x.configurable,
        'value' in x ? (v === null ? 'null' : typeof v) : 'accessor', typeof v === 'function' ? v.length : null];
}

describe('XChainVM prototype and static descriptors (split surface pin)', function () {

    it('prototype descriptor rows match the unsplit class', function () {
        const rows = Object.getOwnPropertyNames(XChainVM.prototype).sort().map((k) => row(XChainVM.prototype, k));
        assert.deepStrictEqual(rows, BASE_PROTOTYPE_ROWS);
    });

    it('keeps every prototype method non-enumerable', function () {
        assert.deepStrictEqual(Object.keys(XChainVM.prototype), []);
        const methods = Object.getOwnPropertyNames(XChainVM.prototype).filter((k) => typeof XChainVM.prototype[k] === 'function');
        assert.ok(methods.length > 1, 'the prototype has methods to check');
    });

    it('static export rows match the unsplit class, in order', function () {
        const names = Object.getOwnPropertyNames(XChainVM)
            .filter((k) => !['length', 'name', 'prototype'].includes(k) && !LAZY_STATICS.includes(k));
        assert.deepStrictEqual(names.map((k) => row(XChainVM, k)), BASE_STATIC_ROWS);
    });

    it('a constructed VM has no enumerable prototype key in its for...in view', function () {
        const GAS = { VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
            VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
            VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000 };
        const vm = new XChainVM({ gasSchedule: GAS, gasCeiling: 1000, execution: 'in-process' });
        const seen = [];
        for (const k in vm) seen.push(k);
        assert.deepStrictEqual(seen, Object.keys(vm));
        assert.ok(vm instanceof XChainVM);
    });

    describe('installMethods', function () {
        it('defines methods with the flags a class body gives them', function () {
            const target = {};
            function m(a, b) { return a + b; }
            installMethods(target, { m });
            assert.deepStrictEqual(Object.getOwnPropertyDescriptor(target, 'm'),
                { value: m, writable: true, enumerable: false, configurable: true });
        });

        it('installs sources in order, a later source winning a shared key', function () {
            const first = () => 1, second = () => 2, other = () => 3;
            const target = installMethods({}, { a: first, b: other }, { a: second });
            assert.strictEqual(target.a, second);
            assert.strictEqual(target.b, other);
        });

        it('copies symbol keys and skips a source key that is not enumerable', function () {
            const sym = Symbol('s');
            const source = { [sym]: () => 's' };
            Object.defineProperty(source, 'hidden', { value: () => 'h', enumerable: false });
            const target = installMethods({}, source);
            assert.strictEqual(typeof target[sym], 'function');
            assert.strictEqual(Object.prototype.hasOwnProperty.call(target, 'hidden'), false);
        });
    });
});
