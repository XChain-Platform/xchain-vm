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
// Resource fault signal activation, end to end through the isolate boundary.
//
// Once the activation is armed, the out_of_stack status (and its gasUsed clamp
// to the ceiling) is reachable only when the in-isolate recursion or
// native-depth guard really fired, which the guard reports to the host before
// it throws. What the contract throws can no longer pick the status: the
// guard's exact message, a contract-built RangeError, a RangeError subclass and
// a plain object named RangeError all settle exactly like a same-shape throw
// with a neutral message. A real memory-limit disposal settles as
// out_of_memory instead of timeout.
//
// Below the activation (mainnet and testnet today) every case settles exactly
// as it did before the activation existed.

'use strict';

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');

let XChainVM = null;
try {
    XChainVM = require('../../../src/index.js'); // requires isolated-vm (Node 22)
} catch (e) { /* skipped below */ }

const CEILING = 1000000;
// A block time past every 2.0.0 flag day, so the error-classifier hardening and
// the native-depth guards are on in every mode below; only the new activation
// differs between them.
const BLOCK_TIME = 1800000000;
const ARMED   = { network: 'regtest', blockContext: { height: 100, timestamp: BLOCK_TIME, hash: 'h' } };
const MAINNET = { network: 'mainnet', blockContext: { height: 5000000, timestamp: BLOCK_TIME, hash: 'h' } };
// Below every v0.24.0 testnet height (BTC 156908 is the lowest), where testnet still settles as before.
const TESTNET = { network: 'testnet', blockContext: { height: 156907, timestamp: BLOCK_TIME, hash: 'h' } };

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const lit = (s) => JSON.stringify(s);
const neutral = (s) => JSON.stringify('Q'.repeat(s.length));

// Each spoof is paired with a twin of the same shape and message length, so the
// two differ only in the message text and the verdict cannot rest on that text alone.
const SPOOFS = [
    { id: 'guard message on a plain Error', msg: 'maximum call stack depth exceeded',
        build: (m) => `throw new Error(${m});` },
    { id: 'guard message on a plain object', msg: 'maximum call stack depth exceeded',
        build: (m) => `throw { message: ${m} };` },
    { id: 'contract-built RangeError with any call stack text', msg: 'call stack',
        build: (m) => `throw new RangeError(${m});` },
    { id: 'contract-built RangeError with the native overflow text', msg: 'Maximum call stack size exceeded',
        build: (m) => `throw new RangeError(${m});` },
    { id: 'RangeError subclass', msg: 'call stack',
        build: (m) => `class X extends RangeError {} throw new X(${m});` },
    { id: 'plain object named RangeError', msg: 'Maximum call stack size exceeded',
        build: (m) => `throw { name: 'RangeError', message: ${m} };` },
    { id: 'RangeError with padded native text', msg: ' Maximum call stack size exceeded ',
        build: (m) => `throw new RangeError(${m});` },
    // Armed beside the native stack activation, whose hooks must recognise only the
    // RangeError V8 itself raised, never a value the contract built or reshaped.
    { id: 'RangeError called without new', msg: 'Maximum call stack size exceeded',
        build: (m) => `throw RangeError(${m});` },
    { id: 'AggregateError moved onto RangeError.prototype', msg: 'Maximum call stack size exceeded',
        build: (m) => `var e = new AggregateError([], ${m}); Object.setPrototypeOf(e, RangeError.prototype); throw e;` },
    { id: 'plain object on RangeError.prototype', msg: 'Maximum call stack size exceeded',
        build: (m) => `var e = Object.create(RangeError.prototype); e.message = ${m}; throw e;` },
    { id: 'engine RangeError with a rewritten message', msg: 'Maximum call stack size exceeded',
        build: (m) => `try { new Array(-1); } catch (e) { e.message = ${m}; throw e; }` },
    { id: 'constructor taken from an engine RangeError', msg: 'Maximum call stack size exceeded',
        build: (m) => `var C; try { new Array(-1); } catch (e) { C = e.constructor; } throw new C(${m});` },
];

const REAL_RECURSION = wrap('function f(n){ return f(n+1); } return f(0);');
const REAL_RECURSION_CAUGHT = wrap('function f(n){ return f(n+1); } try { f(0); } catch (e) {} throw new Error(\'x\');');
const REAL_NATIVE_DEPTH = wrap('var a=[]; for (var i=0;i<20000;i++) a=[a]; return a.join(\',\').length;');
const REAL_OOM = wrap('var a = [...new Array(100000000)]; return a.length;');

// Run one contract in a fresh VM and record the host signals the classifier saw.
async function run(code, mode) {
    const vm = createVM({ maxCpuTimeMs: 2000 });
    let seenSignals = null;
    const classify = vm.classifyError;
    vm.classifyError = function (err, gasTracker, collector, opts, execContext, hostSignals) {
        seenSignals = hostSignals;
        return classify.apply(this, arguments);
    };
    vm.beginBlock();
    const r = await execute(vm, code, mode);
    vm.endBlock();
    return { error: r.error, gasUsed: r.gasUsed, success: r.success, signals: seenSignals };
}

function describeArmedSpoofs() {
    describe('armed (regtest): a thrown value cannot choose out_of_stack', function () {
        for (const s of SPOOFS) {
            it(`${s.id} settles like its neutral twin`, async function () {
                const spoof = await run(wrap(s.build(lit(s.msg))), ARMED);
                const twin  = await run(wrap(s.build(neutral(s.msg))), ARMED);
                assert.ok(String(twin.error).startsWith('error: '), 'twin: ' + twin.error);
                assert.ok(String(spoof.error).startsWith('error: '), 'spoof settled as ' + spoof.error);
                assert.strictEqual(spoof.gasUsed, twin.gasUsed);
                assert.notStrictEqual(spoof.gasUsed, CEILING);
                assert.strictEqual(spoof.signals.stackFault, false);
            });
        }
    });
}

function describeArmedRealFaults() {
    describe('armed (regtest): a real guard trip still settles out_of_stack at the ceiling', function () {
        const REAL = [
            ['unbounded recursion trips the recursion guard and reports it to the host', REAL_RECURSION],
            ['a caught guard trip followed by a plain throw still settles out_of_stack', REAL_RECURSION_CAUGHT],
            ['a deeply nested array join trips the native-depth guard and reports it to the host', REAL_NATIVE_DEPTH],
        ];
        for (const [title, code] of REAL) {
            it(title, async function () {
                const r = await run(code, ARMED);
                assert.strictEqual(r.error, 'out_of_stack: maximum call depth exceeded');
                assert.strictEqual(r.gasUsed, CEILING);
                assert.strictEqual(r.signals.stackFault, true);
            });
        }
    });
    describe('armed (regtest): a real memory-limit disposal settles out_of_memory', function () {
        it('a memory-limit disposal is out_of_memory at the ceiling, not timeout', async function () {
            const r = await run(REAL_OOM, ARMED);
            assert.strictEqual(r.error, 'out_of_memory: isolate memory limit exceeded');
            assert.strictEqual(r.gasUsed, CEILING);
        });
    });
}

function describeUnarmed(label, mode) {
    describe(`unarmed (${label}): settles exactly as before the activation`, function () {
        for (const s of SPOOFS) {
            it(`${s.id} keeps its previous settle result`, async function () {
                const r = await run(wrap(s.build(lit(s.msg))), mode);
                assert.strictEqual(r.error, 'out_of_stack: maximum call depth exceeded');
                assert.strictEqual(r.gasUsed, CEILING);
            });
        }
        it('a real guard trip settles out_of_stack at the ceiling', async function () {
            const r = await run(REAL_RECURSION, mode);
            assert.strictEqual(r.error, 'out_of_stack: maximum call depth exceeded');
            assert.strictEqual(r.gasUsed, CEILING);
        });
        it('a memory-limit disposal keeps its timeout settle result', async function () {
            const r = await run(REAL_OOM, mode);
            assert.strictEqual(r.error, 'timeout: wall-clock safety net triggered');
            assert.strictEqual(r.gasUsed, CEILING);
        });
    });
}

(XChainVM ? describe : describe.skip)('resource fault signal activation: settle results', function () {
    this.timeout(120000);
    describeArmedSpoofs();
    describeArmedRealFaults();
    describeUnarmed('mainnet', MAINNET);
    describeUnarmed('testnet', TESTNET);
});
