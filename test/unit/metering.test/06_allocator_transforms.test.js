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

const assert = require('assert');
const { meterCode } = require('../../../src/metering.js');

function registerTemplateAllocatorTests() {
    it('rewrites a plain tagged template to __tmpltag', function() {
        const metered = meterCode('var s = tag`hello ${name} world`;');
        assert(metered.includes('__tmpltag('), 'plain tag → __tmpltag');
    });

    it('rewrites a member tagged template to __tmpltagm', function() {
        const metered = meterCode('var s = String.raw`a${b}c`;');
        assert(metered.includes('__tmpltagm('), 'member tag → __tmpltagm');
    });

    it('handles a tagged template with an invalid cooked escape (cooked == null)', function() {
        // \\unicode is an invalid escape; cooked is null in a tagged template → void 0.
        const metered = meterCode('var s = tag`\\unicode`;');
        assert(metered.includes('__tmpltag('), 'still rewrites; cooked null path exercised');
    });

    it('rewrites an untagged template literal to __tmpl', function() {
        const metered = meterCode('var s = `q0${e0}q1${e1}q2`;');
        assert(metered.includes('__tmpl('), 'template literal → __tmpl');
    });
}

function registerSpreadAllocatorTests() {
    it('rewrites array spread to __arrspread', function() {
        const metered = meterCode('var a = [x, ...rest, y];');
        assert(metered.includes('__arrspread('), 'array spread → __arrspread');
    });

    it('rewrites array spread when the array also has holes', function() {
        // Metering holes mixed with spread prevents [, ...rest] from performing
        // a free O(n) copy. The hole rides as an ['h'] segment.
        const metered = meterCode('var a = [x, , ...rest];');
        assert(metered.includes('__arrspread('), 'holes + spread → __arrspread');
        assert(metered.includes("'h'") || metered.includes('"h"'), 'hole encoded as h segment');
    });

    it('rewrites object spread to __objspread', function() {
        const metered = meterCode('var o = {...base, k: v, [c]: d};');
        assert(metered.includes('__objspread('), 'object spread → __objspread');
    });

    it('wraps the spread source when object spread is combined with a method/accessor', function() {
        // The literal keeps its method shorthand verbatim (so `this`/getter
        // semantics are untouched), but each spread source is now wrapped in
        // __objspreadmeter so the copy is charged instead of being free.
        const metered = meterCode('var o = {...base, m() { return 1; }};');
        assert(!metered.includes('__objspread('), 'method + spread → not rebuilt via __objspread');
        assert(metered.includes('__objspreadmeter('), 'spread source metered via __objspreadmeter');
        assert(metered.includes('m('), 'method shorthand preserved');
    });
}

function registerConcatAllocatorTests() {
    it('rewrites a member += concat to __setconcat', function() {
        const metered = meterCode('obj.prop += "x";');
        assert(metered.includes('__setconcat('), 'member concat-assign → __setconcat');
    });

    it('rewrites a computed-member += concat to __setconcat', function() {
        // obj[k] += "x", the computed member key path of memberKeyExpr.
        const metered = meterCode('obj[k] += "x";');
        assert(metered.includes('__setconcat('), 'computed member concat-assign → __setconcat');
    });

    // L-3 gate: default (pre-gate) keeps the legacy __setconcat form; the
    // spec-correct order (read obj[k] before rhs) is emitted as __setconcatL
    // with a deferred rhs thunk only when specEvalOrder is set. Default output
    // must stay byte-stable so historical blocks replay identically.
    it('default meterCode keeps legacy __setconcat (no __setconcatL) for member +=', function() {
        const metered = meterCode('obj.prop += "x";');
        assert(metered.includes('__setconcat('), 'default must emit __setconcat');
        assert(!/__setconcatL\(/.test(metered), 'default must NOT emit the gated __setconcatL');
    });

    it('specEvalOrder emits __setconcatL with a thunked rhs for member +=', function() {
        const metered = meterCode('obj.prop += "x";', { specEvalOrder: true });
        assert(/__setconcatL\(/.test(metered), 'gated path must emit __setconcatL');
        assert(/=>/.test(metered), 'gated path must defer rhs behind an arrow thunk');
    });

    it('specEvalOrder does not disturb bare-identifier += (still __concat)', function() {
        const metered = meterCode('var s = "a"; s += "b";', { specEvalOrder: true });
        assert(metered.includes('__concat('), 'identifier += stays __concat under the gate');
        assert(!/__setconcatL\(/.test(metered), 'identifier += must not route through __setconcatL');
    });

    it('rewrites object spread with a string-literal key', function() {
        // non-computed Literal key → astLiteral(p.key.value) branch.
        const metered = meterCode('var o = {...base, "strkey": v};');
        assert(metered.includes('__objspread('), 'string-literal key handled');
    });
}

function registerCallSpreadTests() {
    // The meterCallSpread gate: call/new/method argument spread is rebuilt
    // through __arrspread only when meterCallSpread is set. Default (pre-gate)
    // output stays byte-stable so historical blocks replay identically
    // (legacy flat __gas(1) per call).
    it('default meterCode leaves call/new argument spread verbatim (no __arrspread)', function() {
        const call = meterCode('f(...x);');
        assert(!call.includes('__arrspread('), 'default call spread must NOT route through __arrspread');
        const nw = meterCode('new C(...x);');
        assert(!nw.includes('__arrspread('), 'default new spread must NOT route through __arrspread');
        const push = meterCode('arr.push(a, ...x);');
        assert(!push.includes('__arrspread('), 'default method spread must NOT route through __arrspread');
    });

    it('meterCallSpread rewrites f(...x) / new C(...x) / arr.push(a, ...x) through __arrspread', function() {
        const opt = { meterCallSpread: true };
        const call = meterCode('f(...x);', opt);
        assert(call.includes('__arrspread('), 'gated call spread → __arrspread');
        const nw = meterCode('new C(...x);', opt);
        assert(nw.includes('__arrspread('), 'gated new spread → __arrspread');
        assert(nw.includes('new C('), 'constructor call preserved');
        const push = meterCode('arr.push(a, ...x);', opt);
        assert(push.includes('__arrspread('), 'gated method spread → __arrspread');
        assert(/'e'|"e"/.test(push), 'non-spread arg rides as an e segment');
    });

    it('meterCallSpread does not touch a call with no spread argument', function() {
        const metered = meterCode('f(a, b);', { meterCallSpread: true });
        assert(!metered.includes('__arrspread('), 'plain call must not be rewritten');
    });

    it('meterCallSpread output re-parses under the ES2020 pin', function() {
        const metered = meterCode('obj.method(a, ...x, b); new C(...y);', { meterCallSpread: true });
        require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
    });
}

function registerRestPatternDeclarationTests() {
    // REST_PATTERN_METER gate: a destructuring rest is an ArrayPattern/ObjectPattern
    // carrying a RestElement, NOT an Expression carrying a SpreadElement, so every
    // branch above missed it and `var [...c] = bigArr` performed a native O(n) copy
    // for a flat __gas(1). Post-gate the SOURCE is wrapped in the size-charged helper
    // that matches the copy. Pre-gate output stays byte-stable so historical blocks
    // replay identically.
    it('default meterCode leaves rest destructuring verbatim (no helper wrap)', function() {
        const arr = meterCode('var [x, ...c] = a;');
        assert(arr.includes('var [x, ...c] = a'), 'pre-gate array rest emitted verbatim: ' + arr);
        assert(!arr.includes('__arrspread('), 'pre-gate array rest must NOT route through __arrspread');
        const obj = meterCode('var {k, ...c} = o;');
        assert(obj.includes('var {k, ...c} = o'), 'pre-gate object rest emitted verbatim: ' + obj);
        assert(!obj.includes('__objspreadmeter('), 'pre-gate object rest must NOT route through __objspreadmeter');
    });

    it('meterRestPattern wraps the SOURCE of var [x, ...c] = a in __arrspread', function() {
        const metered = meterCode('var [x, ...c] = a;', { meterRestPattern: true });
        assert(metered.includes('__arrspread('), 'gated array rest source → __arrspread: ' + metered);
        assert(metered.includes('var [x, ...c] ='), 'the PATTERN itself is untouched: ' + metered);
        assert(/'s'|"s"/.test(metered), 'the source rides as an s (spread) segment');
    });

    it('meterRestPattern wraps the SOURCE of var {k, ...c} = o in __objspreadmeter', function() {
        const metered = meterCode('var {k, ...c} = o;', { meterRestPattern: true });
        assert(metered.includes('__objspreadmeter(o)'), 'gated object rest source → __objspreadmeter: ' + metered);
        assert(metered.includes('var {k, ...c} ='), 'the PATTERN itself is untouched: ' + metered);
    });
}

function registerRestPatternSafetyTests() {
    it('meterRestPattern covers the assignment-expression forms too', function() {
        const arr = meterCode('[a, ...c] = x;', { meterRestPattern: true });
        assert(arr.includes('__arrspread('), 'array-rest assignment rhs → __arrspread: ' + arr);
        const obj = meterCode('({k, ...c} = o);', { meterRestPattern: true });
        assert(obj.includes('__objspreadmeter(o)'), 'object-rest assignment rhs → __objspreadmeter: ' + obj);
    });

    // Load-bearing: __arrspread materialises the iterable, which DRAINS it. That is
    // sound for a rest (which drains it anyway) and NOT sound for a rest-less pattern,
    // where a lazy source must stay lazy. The narrowness of the trigger is the safety
    // property, so pin it directly.
    it('meterRestPattern leaves a rest-LESS destructure completely alone', function() {
        const arr = meterCode('var [x, y] = a;', { meterRestPattern: true });
        assert(!arr.includes('__arrspread('), 'rest-less array pattern must not be drained: ' + arr);
        assert.strictEqual(arr, meterCode('var [x, y] = a;'), 'byte-identical to pre-gate output');
        const obj = meterCode('var {k, j} = o;', { meterRestPattern: true });
        assert(!obj.includes('__objspreadmeter('), 'rest-less object pattern must not be wrapped: ' + obj);
        assert.strictEqual(obj, meterCode('var {k, j} = o;'), 'byte-identical to pre-gate output');
    });

    // A for-of/for-in head declarator has NO init, so there is no source expression
    // to wrap; it is rejected at deploy (lint_core banned-rest) instead of metered.
    it('meterRestPattern leaves a for-of head rest alone (no init to wrap)', function() {
        const metered = meterCode('for (var [x, ...c] of xs) { y = 1; }', { meterRestPattern: true });
        assert(!metered.includes('__arrspread('), 'for-of head has no addressable source: ' + metered);
    });

    it('meterRestPattern output re-parses under the ES2020 pin', function() {
        const metered = meterCode('var [x, ...c] = a; var {k, ...d} = o; [p, ...q] = z;',
            { meterRestPattern: true });
        require('acorn').parse(metered, { ecmaVersion: 2020, sourceType: 'script' });
    });
}

describe('Metering', function() {

    // Allocator transforms (Phase 0)
    // transformAllocators rewrites syntax-level allocators into metered helper
    // calls before gas injection. Each construct emits a distinct helper marker.
    describe('allocator transforms', function() {
    registerTemplateAllocatorTests();
    registerSpreadAllocatorTests();
    registerConcatAllocatorTests();
    registerCallSpreadTests();
    registerRestPatternDeclarationTests();
    registerRestPatternSafetyTests();
    });
});
