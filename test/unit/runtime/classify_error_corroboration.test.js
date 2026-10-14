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
// e9c3a80b (flag-day Pkg 4): post-VM_LINT_HARDENING the resource
// branches of classifyError (timeout / out_of_memory / out_of_stack) require
// a corroborating HOST signal before collapsing the status and clamping
// gasUsed to the ceiling; an attacker-authored message substring alone routes
// to the generic sanitized 'error:' classification with the real gasUsed.
// Pre-gate the legacy message-only classification is preserved (replay parity).
//
// The out_of_stack corroboration by RangeError class, name or the guard's exact
// text holds only below the resource fault signal activation. Contract code can
// build every one of those, so once that activation is on (hostSignals.
// stackFaultGateOn) out_of_stack needs the guard's own host report
// (hostSignals.stackFault), and a real memory-limit disposal is out_of_memory.

'use strict';

const assert = require('assert');

let XChainVM = null;
try {
    XChainVM = require('../../../src/index.js'); // requires isolated-vm (Node 22 / Linux)
} catch (e) { /* skipped below */ }

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

const CEILING = 1000000;
let vm;

function initializeVM() {
    if (!vm) {
        vm = new XChainVM({ gasSchedule: GAS_SCHEDULE, gasCeiling: CEILING, execution: 'in-process' });
    }
}

function tracker(used) {
    return { used, ceiling: CEILING, getUsed: () => used };
}
const collector = { getLogs: () => [] };
const HARDENED = { network: 'regtest', contractAddress: 'C', method: 'm' };
const LEGACY   = { network: 'mainnet', contractAddress: 'C', method: 'm' };

function signals(over) {
    return Object.assign({
        runStartNs: process.hrtime.bigint(),
        getIsolate: () => ({ isDisposed: false })
    }, over);
}

function classify(err, opts, hostSignals, used) {
    return vm.classifyError(err, tracker(used == null ? 777 : used), collector,
        opts, { reverted: false }, hostSignals);
}

(XChainVM ? describe : describe.skip)('classifyError host-signal corroboration (e9c3a80b)', function () {
    before(initializeVM);

    describe('post-gate (hardened)', function () {
        it('rejects a spoofed timeout message (no wall-clock, isolate alive) -> generic error, real gasUsed', function () {
            const r = classify(new Error('Script execution timed out.'), HARDENED, signals());
            assert.ok(r.error.startsWith('error: '), r.error);
            assert.strictEqual(r.gasUsed, 777);
        });
        it('accepts a real timeout (elapsed >= maxCpuTimeMs) -> timeout, clamped', function () {
            const r = classify(new Error('Script execution timed out.'), HARDENED,
                signals({ runStartNs: process.hrtime.bigint() - BigInt(vm.limits.maxCpuTimeMs + 5) * 1000000n }));
            assert.ok(r.error.startsWith('timeout:'), r.error);
            assert.strictEqual(r.gasUsed, CEILING);
        });
        it('accepts a disposed-isolate termination -> timeout, clamped', function () {
            const r = classify(new Error('Isolate is disposed'), HARDENED,
                signals({ getIsolate: () => ({ isDisposed: true }) }));
            assert.ok(r.error.startsWith('timeout:'), r.error);
        });
        it('rejects a spoofed out-of-memory message (isolate alive) -> generic error', function () {
            const r = classify(new Error('pretend out of memory please'), HARDENED, signals());
            assert.ok(r.error.startsWith('error: '), r.error);
            assert.strictEqual(r.gasUsed, 777);
        });
        it('accepts a real OOM (isolate disposed) -> out_of_memory, clamped', function () {
            const r = classify(new Error('Array buffer allocation failed'), HARDENED,
                signals({ getIsolate: () => ({ isDisposed: true }) }));
            assert.ok(r.error.startsWith('out_of_memory:'), r.error);
            assert.strictEqual(r.gasUsed, CEILING);
        });
        it('rejects a spoofed call-stack message (plain Error) -> generic error', function () {
            const r = classify(new Error('haha call stack haha'), HARDENED, signals());
            assert.ok(r.error.startsWith('error: '), r.error);
            assert.strictEqual(r.gasUsed, 777);
        });
        it('accepts a real native overflow (RangeError) -> out_of_stack, clamped', function () {
            // Below the resource fault signal activation the class alone corroborates.
            const r = classify(new RangeError('Maximum call stack size exceeded'), HARDENED,
                signals({ stackFaultGateOn: false }));
            assert.ok(r.error.startsWith('out_of_stack:'), r.error);
            assert.strictEqual(r.gasUsed, CEILING);
        });
        it("accepts the recursion guard's exact deterministic fault -> out_of_stack, clamped", function () {
            // Below the resource fault signal activation the exact text alone corroborates.
            const r = classify(new Error('maximum call stack depth exceeded'), HARDENED,
                signals({ stackFaultGateOn: false }));
            assert.ok(r.error.startsWith('out_of_stack:'), r.error);
        });
        it('activates on mainnet at/after the flag-day block time', function () {
            const opts = { network: 'mainnet', blockContext: { timestamp: 1786060800 } };
            const r = classify(new Error('Script execution timed out.'), opts, signals());
            assert.ok(r.error.startsWith('error: '), r.error);
        });
    });
});

(XChainVM ? describe : describe.skip)('classifyError host-signal corroboration (e9c3a80b)', function () {
    before(initializeVM);

    describe('pre-gate (legacy replay parity)', function () {
        it('keeps message-only timeout classification below the flag-day', function () {
            const r = classify(new Error('Script execution timed out.'), LEGACY, signals());
            assert.ok(r.error.startsWith('timeout:'), r.error);
            assert.strictEqual(r.gasUsed, CEILING);
        });
        it('keeps message-only out_of_memory classification below the flag-day', function () {
            const r = classify(new Error('out of memory'), LEGACY, signals());
            assert.ok(r.error.startsWith('out_of_memory:'), r.error);
        });
        it('keeps message-only out_of_stack classification below the flag-day', function () {
            const r = classify(new Error('anything call stack anything'), LEGACY, signals());
            assert.ok(r.error.startsWith('out_of_stack:'), r.error);
        });
        it('missing host signals fall back to the legacy classification even post-gate (fail-open to legacy)', function () {
            const r = classify(new Error('Script execution timed out.'), HARDENED, undefined);
            assert.ok(r.error.startsWith('timeout:'), r.error);
        });
    });
});

(XChainVM ? describe : describe.skip)('classifyError resource fault signal corroboration', function () {
    before(initializeVM);

    const ARMED = (over) => signals(Object.assign({ stackFaultGateOn: true, stackFault: false }, over));
    const SPOOFED_STACK_ERRORS = [
        ['a contract-built RangeError', () => new RangeError('Maximum call stack size exceeded')],
        ["the recursion guard's exact text on a plain Error", () => new Error('maximum call stack depth exceeded')],
        ['a plain object named RangeError', () => ({ name: 'RangeError', message: 'call stack' })],
    ];

    for (const [label, make] of SPOOFED_STACK_ERRORS) {
        it(`rejects ${label} without the guard's host report -> generic error, real gasUsed`, function () {
            const r = classify(make(), HARDENED, ARMED());
            assert.ok(r.error.startsWith('error: '), r.error);
            assert.strictEqual(r.gasUsed, 777);
        });
    }
    it("accepts the guard's exact fault with its host report -> out_of_stack, clamped", function () {
        const r = classify(new Error('maximum call stack depth exceeded'), HARDENED, ARMED({ stackFault: true }));
        assert.ok(r.error.startsWith('out_of_stack:'), r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });
    it('names a real memory-limit disposal out_of_memory, clamped', function () {
        const r = classify(new Error('Isolate was disposed during execution due to memory limit'), HARDENED,
            ARMED({ getIsolate: () => ({ isDisposed: true }) }));
        assert.ok(r.error.startsWith('out_of_memory:'), r.error);
        assert.strictEqual(r.gasUsed, CEILING);
    });
    it('keeps a memory-limit message with the isolate alive out of every resource status', function () {
        const r = classify(new Error('Isolate was disposed during execution due to memory limit'), HARDENED, ARMED());
        assert.ok(r.error.startsWith('error: '), r.error);
        assert.strictEqual(r.gasUsed, 777);
    });
    it('keeps the memory-limit disposal a timeout below the activation', function () {
        const r = classify(new Error('Isolate was disposed during execution due to memory limit'), HARDENED,
            signals({ stackFaultGateOn: false, getIsolate: () => ({ isDisposed: true }) }));
        assert.ok(r.error.startsWith('timeout:'), r.error);
    });
    it('ignores the activation flag on a pre-hardening block (legacy message-only replay)', function () {
        const r = classify(new Error('anything call stack anything'), LEGACY, ARMED());
        assert.ok(r.error.startsWith('out_of_stack:'), r.error);
    });
});
