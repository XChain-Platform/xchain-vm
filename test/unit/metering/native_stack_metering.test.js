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
 * Metering transform under the native stack activation.
 *
 * Armed, every catch and finally hands its in-flight value to the meter's
 * leading charge, every function guard and the top-level script charge a
 * frame weight, and call/new spread holds its argument count for the call.
 * Unarmed, the output is byte-identical to the legacy transform.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const acorn = require('acorn');
const { meterCode } = require('../../../src/metering.js');
const { frameWeight, SLOTS_PER_UNIT } = require('../../../src/metering/frame_weight.js');

const ARMED = { specEvalOrder: true, meterCallSpread: true, nativeStackTerminal: true };
const UNARMED = { specEvalOrder: true, meterCallSpread: true };
const wrap = (body) => 'module.exports = function(xchain) { ' + body + ' };';
const parse = (src) => acorn.parse(src, { ecmaVersion: 2020, sourceType: 'script', allowReturnOutsideFunction: true });
const fnNode = (src) => parse(src).body[0];

describe('metering: native stack activation, catch and finally', function () {
    it('leaves the transform byte-identical when the activation is off', function () {
        const src = wrap('function r(n){ try { return r(n + 1); } catch (e) { return n; } finally { n = 0; } } ' +
            'try { r(0); } catch {} return Math.max(...[1, 2]);');
        assert.strictEqual(meterCode(src, Object.assign({ nativeStackTerminal: false }, UNARMED)), meterCode(src, UNARMED));
        assert.ok(!/__gas\(1, /.test(meterCode(src, UNARMED)));
        assert.ok(/__depth_enter\(\);/.test(meterCode(src, UNARMED)));
    });

    it('hands the caught value to the leading catch charge', function () {
        const out = meterCode(wrap('try { f(); } catch (e) { return e; }'), ARMED);
        assert.match(out, /catch \(e\) \{\s*__gas\(1, e\);/);
    });

    it('binds a fresh name for a catch without a binding', function () {
        const out = meterCode(wrap('try { f(); } catch { return 1; }'), ARMED);
        assert.match(out, /catch \(__gasx\) \{\s*__gas\(1, __gasx\);/);
    });

    it('destructures a catch pattern only after the check', function () {
        const out = meterCode(wrap('try { f(); } catch ({ m, z = g() }) { return m; }'), ARMED);
        assert.match(out, /catch \(__gasx\) \{\s*__gas\(1, __gasx\);\s*let \{m, z = /);
    });

    it('records the in-flight value for a finally with no call, then checks it first', function () {
        const out = meterCode(wrap('try { f(); } finally { return 1; }'), ARMED);
        assert.match(out, /let __gasf;\s*try \{[\s\S]*\} catch \(__gasx\) \{\s*__gasf = __gasx;\s*throw __gasx;\s*\} finally \{\s*__gas\(1, __gasf\);\s*return 1;/);
    });

    it('wraps a try with both a catch and a finally so either can be checked', function () {
        const out = meterCode(wrap('try { f(); } catch (e) { g(); } finally { h(); }'), ARMED);
        assert.match(out, /try \{\s*try \{\s*__gas\(1\);[\s\S]*\} catch \(e\) \{\s*__gas\(1, e\);[\s\S]*\}\s*\} catch \(__gasx\)/);
    });

    it('picks local names the contract source does not use', function () {
        const out = meterCode(wrap('var __gasx = 1, __gasf = 2; try { f(); } catch { return __gasx + __gasf; } finally { }'), ARMED);
        assert.match(out, /catch \(__gasx_\)/);
        assert.match(out, /let __gasf_;/);
    });

    it('keeps the gas charges of a try identical (one per block, handler and finalizer)', function () {
        const src = wrap('try { a(); } catch (e) { b(); } finally { c(); }');
        const count = (s) => (s.match(/__gas\(1/g) || []).length;
        assert.strictEqual(count(meterCode(src, ARMED)), count(meterCode(src, UNARMED)));
    });

});

describe('metering: native stack activation, depth guards and spread', function () {
    it('charges a weighted depth guard on every function and the top-level script', function () {
        const out = meterCode(wrap('function r(n){ return n; } var g = () => 1;'), ARMED);
        assert.strictEqual((out.match(/const __gasd = __depth_enter\(\d+\);/g) || []).length, 4);
        assert.strictEqual((out.match(/__depth_exit\(__gasd, 0\);/g) || []).length, 4);
        assert.match(out, /^__gas\(1\);\s*const __gasd = __depth_enter\(\d+\);/);
        assert.match(out, /__depth_exit\(__gasd, 0\);\s*$/);
    });

    it('checks whatever leaves a guarded frame by throwing, and rethrows it', function () {
        const out = meterCode(wrap('return 1;'), ARMED);
        assert.match(out, /\} catch \(__gasx\) \{\s*__depth_exit\(__gasx\);\s*throw __gasx;\s*\} finally \{\s*__depth_exit\(__gasd, 0\);/);
    });

    it('holds and releases call and new spread arguments, but not array literal spread', function () {
        const out = meterCode(wrap('var a = [1]; var b = [...a]; f(...a); new C(...a); return b;'), ARMED);
        assert.match(out, /__arrspread\(\(__gas\(1\), f\(\.\.\.__arrspread\(\[\["s", a\]\], 1, 0\)\)\), 2, 0\)/);
        assert.match(out, /__arrspread\(new C\(\.\.\.__arrspread\(\[\["s", a\]\], 1, 1\)\), 2, 1\)/);
        assert.match(out, /var b = __arrspread\(\[\["s", a\]\]\);/);
    });

    it('does not wrap a release around a spread call inside an optional chain', function () {
        const out = meterCode(wrap('return x?.f(...a).g;'), ARMED);
        assert.match(out, /x\?\.f\(\.\.\.__arrspread\(\[\["s", a\]\], 1, 0\)\)/);
        assert.ok(!/, 2, 0\)/.test(out));
    });

    it('emits valid script source for every armed shape', function () {
        const out = meterCode(wrap('L: try { if (a) try { b(); } finally { break L; } } catch ({ m }) { } ' +
            'switch (q) { case 1: try { c(); } finally { } } for (;;) try { d(); } finally { break; }'), ARMED);
        assert.doesNotThrow(() => parse(out));
    });
});

describe('metering: frame weight', function () {
    it('is 1 for an ordinary function', function () {
        assert.strictEqual(frameWeight(fnNode('function f(a, b){ var c = a + b; return g(c, 1); }')), 1);
    });

    it('grows with locals, parameters and call arguments', function () {
        const locals = (k) => Array.from({ length: k }, (_, i) => 'var v' + i + ' = ' + i + ';').join(' ');
        const args = (k) => Array.from({ length: k }, () => '0').join(', ');
        assert.ok(frameWeight(fnNode('function f(){ ' + locals(800) + ' }')) >= 800 / SLOTS_PER_UNIT);
        assert.ok(frameWeight(fnNode('function f(){ g(' + args(800) + '); }')) >= 800 / SLOTS_PER_UNIT);
        assert.ok(frameWeight(fnNode('function f(' + Array.from({ length: 200 }, (_, i) => 'p' + i).join(', ') + '){ }')) > 1);
    });

    it('does not count a nested function body against the outer frame', function () {
        const locals = Array.from({ length: 800 }, (_, i) => 'var v' + i + ' = ' + i + ';').join(' ');
        assert.strictEqual(frameWeight(fnNode('function f(){ function g(){ ' + locals + ' } return g; }')), 1);
    });

    it('does not charge sequential statements as if their temporaries were live together', function () {
        const calls = Array.from({ length: 200 }, () => 'g(1, 2, 3);').join(' ');
        assert.strictEqual(frameWeight(fnNode('function f(){ ' + calls + ' }')), 1);
    });
});
