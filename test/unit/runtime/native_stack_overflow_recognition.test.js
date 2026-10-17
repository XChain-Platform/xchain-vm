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
// Native stack activation: only an engine-raised overflow is terminal.
//
// The armed catch, finally and frame-exit hooks turn a native stack overflow
// into the terminal depth fault. They must recognise the RangeError V8 itself
// raised, and nothing a contract can build: a constructed RangeError with V8's
// text, an Error or AggregateError moved onto RangeError.prototype, a plain
// object on that prototype (with or without a toStringTag), an engine-raised
// RangeError whose message the contract rewrote after catching it, and every
// route back to the native constructors. Each spoof is paired with a twin of
// the same shape and message length; caught or discarded by a finally, the two
// must settle identically and keep running. Real overflows stay terminal, and
// constructing an error costs the same gas armed as unarmed.

'use strict';

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');

let XChainVM = null;
try {
    XChainVM = require('../../../src/index.js'); // requires isolated-vm (Node 22)
} catch (e) { /* skipped below */ }

const CEILING = 1000000;
const BLOCK_TIME = 1800000000;
const ARMED   = { network: 'regtest', blockContext: { height: 100, timestamp: BLOCK_TIME, hash: 'h' } };
const MAINNET = { network: 'mainnet', blockContext: { height: 5000000, timestamp: BLOCK_TIME, hash: 'h' } };
const TESTNET = { network: 'testnet', blockContext: { height: 5000000, timestamp: BLOCK_TIME, hash: 'h' } };

const OVERFLOW_TEXT = 'Maximum call stack size exceeded';
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const lit = (s) => JSON.stringify(s);
const neutral = (s) => JSON.stringify('Q'.repeat(s.length));

// The spoofs of the resource fault signal suite, then every other way a
// contract can build or reshape a value that looks like V8's overflow.
const SPOOFS = [
    { id: 'guard message on a plain Error', msg: 'maximum call stack depth exceeded',
        build: (m) => `throw new Error(${m});` },
    { id: 'guard message on a plain object', msg: 'maximum call stack depth exceeded',
        build: (m) => `throw { message: ${m} };` },
    { id: 'contract-built RangeError with any call stack text', msg: 'call stack',
        build: (m) => `throw new RangeError(${m});` },
    { id: 'contract-built RangeError with the native overflow text', msg: OVERFLOW_TEXT,
        build: (m) => `throw new RangeError(${m});` },
    { id: 'RangeError subclass', msg: 'call stack',
        build: (m) => `class X extends RangeError {} throw new X(${m});` },
    { id: 'plain object named RangeError', msg: OVERFLOW_TEXT,
        build: (m) => `throw { name: 'RangeError', message: ${m} };` },
    { id: 'RangeError with padded native text', msg: ' ' + OVERFLOW_TEXT + ' ',
        build: (m) => `throw new RangeError(${m});` },
    { id: 'RangeError called without new', msg: OVERFLOW_TEXT,
        build: (m) => `throw RangeError(${m});` },
    { id: 'RangeError subclass with the native overflow text', msg: OVERFLOW_TEXT,
        build: (m) => `class X extends RangeError {} throw new X(${m});` },
    { id: 'TypeError subclass moved onto RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `class X extends TypeError {} var e = new X(${m}); Object.setPrototypeOf(e, RangeError.prototype); throw e;` },
    { id: 'Error moved onto RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `var e = new Error(${m}); Object.setPrototypeOf(e, RangeError.prototype); throw e;` },
    { id: 'AggregateError moved onto RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `var e = new AggregateError([], ${m}); Object.setPrototypeOf(e, RangeError.prototype); throw e;` },
    { id: 'plain object on RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `var e = Object.create(RangeError.prototype); e.message = ${m}; throw e;` },
    { id: 'plain object on RangeError.prototype tagged Error', msg: OVERFLOW_TEXT,
        build: (m) => `var e = Object.create(RangeError.prototype); e.message = ${m}; e[Symbol.toStringTag] = 'Error'; throw e;` },
    { id: 'plain object after tagging RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `try { RangeError.prototype[Symbol.toStringTag] = 'Error'; } catch (z) {} ` +
            `var e = Object.create(RangeError.prototype); e.message = ${m}; throw e;` },
    { id: 'plain object given a captured stack', msg: OVERFLOW_TEXT,
        build: (m) => `var e = Object.create(RangeError.prototype); Error.captureStackTrace(e); e.message = ${m}; throw e;` },
    { id: 'engine RangeError with a rewritten message', msg: OVERFLOW_TEXT,
        build: (m) => `try { new Array(-1); } catch (e) { e.message = ${m}; throw e; }` },
    { id: 'constructor taken from an engine RangeError', msg: OVERFLOW_TEXT,
        build: (m) => `var C; try { new Array(-1); } catch (e) { C = e.constructor; } throw new C(${m});` },
    { id: 'constructor taken from RangeError.prototype', msg: OVERFLOW_TEXT,
        build: (m) => `var C = RangeError.prototype.constructor; throw new C(${m});` },
    { id: 'Error taken from the RangeError prototype chain', msg: OVERFLOW_TEXT,
        build: (m) => `var E = Object.getPrototypeOf(RangeError); var e = new E(${m}); ` +
            `Object.setPrototypeOf(e, RangeError.prototype); throw e;` },
];

// The spoof thrown inside a try whose catch keeps running, and inside a try whose
// finally discards it with break.
const SHAPES = [
    ['caught', (b) => wrap(`var n = 0; try { ${b} } catch (e) { n = 1; } return n;`)],
    ['discarded by a finally', (b) => wrap(`var n = 0; for (;;) { try { ${b} } finally { n = 2; break; } } return n;`)],
];

// Fat frames run the native stack out in tens of calls, well before the depth counter.
const locals = (n) => Array.from({ length: n }, (_, i) => 'var v' + i + ' = n + ' + i + ';').join(' ');
const FAT = 'function r(n){ ' + locals(800) + ' return r(n + 1) + v0 + v799; }';
const REAL = [
    ['a native overflow caught by the contract', wrap(FAT + ' try { r(0); } catch (e) { return 1; }')],
    ['a native overflow discarded by a finally', wrap(FAT + ' for (;;) { try { r(0); } finally { break; } } return 1;')],
    ['a native overflow caught after the contract caught and rethrew other errors',
        wrap(FAT + ' for (var i = 0; i < 3; i++) { try { try { new Array(-1); } catch (e) { throw e; } } catch (e2) {} } ' +
            'try { r(0); } catch (e) { return 1; }')],
    ['unbounded recursion caught by the contract', wrap('function f(n){ return f(n + 1); } try { f(0); } catch (e) { return 1; }')],
    ['a deeply nested array join caught by the contract',
        wrap('var a = []; for (var i = 0; i < 20000; i++) a = [a]; try { return a.join(",").length; } catch (e) { return 1; }')],
];

async function run(code, mode) {
    const vm = createVM({ maxCpuTimeMs: 5000 });
    vm.beginBlock();
    const r = await execute(vm, code, mode);
    vm.endBlock();
    return { success: r.success, error: r.error, gasUsed: r.gasUsed, returnValue: r.returnValue };
}

function describeSpoofs(label, mode) {
    describe(`${label}: a contract-built value never counts as a native overflow`, function () {
        for (const s of SPOOFS) {
            for (const [shape, code] of SHAPES) {
                it(`${s.id}, ${shape}, settles like its neutral twin`, async function () {
                    const spoof = await run(code(s.build(lit(s.msg))), mode);
                    const twin  = await run(code(s.build(neutral(s.msg))), mode);
                    assert.strictEqual(twin.success, true, 'twin: ' + twin.error);
                    assert.deepStrictEqual(spoof, twin);
                });
            }
        }
    });
}

(XChainVM ? describe : describe.skip)('native stack activation: overflow recognition', function () {
    this.timeout(120000);

    describeSpoofs('armed (regtest)', ARMED);

    describe('armed (regtest): an engine-raised overflow stays terminal', function () {
        for (const [title, code] of REAL) {
            it(title, async function () {
                const r = await run(code, ARMED);
                assert.strictEqual(r.error, 'out_of_stack: maximum call depth exceeded');
                assert.strictEqual(r.gasUsed, CEILING);
            });
        }
    });

    describe('armed (regtest): the error constructors keep their shape and cannot be bypassed', function () {
        it('wrapped constructors keep names, lengths, statics, chain and instances', async function () {
            const r = await run(wrap(
                'var ctors = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError];' +
                'var out = []; var fp = Object.getPrototypeOf(function () {});' +
                'for (var i = 0; i < ctors.length; i++) { var C = ctors[i]; var d = Object.getOwnPropertyDescriptor(C, "prototype");' +
                '  var e = i === 7 ? new C([1], "m") : new C("m");' +
                '  out.push([C.name, C.length, C.prototype.constructor === C, Object.getPrototypeOf(C) === (i ? Error : fp),' +
                '    d.writable, d.configurable, e instanceof C, e instanceof Error, Object.getPrototypeOf(e) === C.prototype,' +
                '    e.message, Object.prototype.toString.call(e)].join(":")); }' +
                'class X extends RangeError { constructor(m) { super(m); this.k = 1; } }' +
                'var x = new X("s"); out.push([x instanceof X, x instanceof RangeError, Object.getPrototypeOf(x) === X.prototype, x.k, x.name].join(":"));' +
                'var t; try { null.x; } catch (e) { t = e; } out.push([t.constructor === TypeError, t instanceof TypeError].join(":"));' +
                'out.push([Error.stackTraceLimit, typeof Error.captureStackTrace, new Error("c", { cause: 7 }).cause, String(RangeError("r"))].join(":"));' +
                'return out.join("|");'), ARMED);
            assert.strictEqual(r.success, true, r.error);
            const rows = JSON.parse(r.returnValue).split('|');
            const names = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'];
            names.forEach((n, i) => assert.strictEqual(rows[i],
                [n, i === 7 ? 2 : 1, true, true, false, false, true, true, true, 'm', '[object Error]'].join(':')));
            assert.strictEqual(rows[8], 'true:true:true:1:RangeError');
            assert.strictEqual(rows[9], 'true:true');
            assert.strictEqual(rows[10], '0:function:7:RangeError: r');
        });

        it('constructing errors costs the same gas armed as unarmed', async function () {
            const base = wrap('var n = 0; for (var i = 0; i < 50; i++) { var e = ({ message: "r" + i }); n += e.message.length; } return n;');
            const ctor = wrap('var n = 0; for (var i = 0; i < 50; i++) { var e = new RangeError("r" + i); n += e.message.length; } return n;');
            const sub = wrap('class X extends Error {} var n = 0; for (var i = 0; i < 50; i++) { var e = new X("r" + i); n += e.message.length; } return n;');
            const subBase = wrap('class X {} var n = 0; for (var i = 0; i < 50; i++) { var e = new X("r" + i); e.message = "r" + i; n += e.message.length; } return n;');
            const delta = async (mode, a, b) => (await run(a, mode)).gasUsed - (await run(b, mode)).gasUsed;
            assert.strictEqual(await delta(ARMED, ctor, base), await delta(MAINNET, ctor, base));
            assert.strictEqual(await delta(ARMED, sub, subBase), await delta(MAINNET, sub, subBase));
        });
    });

    describeSpoofs('unarmed (mainnet)', MAINNET);
    describeSpoofs('unarmed (testnet)', TESTNET);
});
