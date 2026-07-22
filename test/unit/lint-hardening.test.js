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
 * VM_LINT_HARDENING rule set (flag-day Pkg 4 / ), two-way:
 * every hardened rule must fire with hardened=true (the default) AND
 * reproduce the legacy verdict with hardened=false (pre-gate replay
 * parity). Acorn-only (lint-core), so this suite runs anywhere.
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    lintSource,
    findBannedAsync,
    findBannedMathCalls,
    findBannedExponentiation,
    findReservedControlBinding,
    SAFE_MATH_MEMBERS,
    RESERVED_CONTROL_BINDINGS
} = require('../../src/lint-core.js');

function firstError(code, opts) {
    const res = lintSource(code, opts);
    const blocking = res.errors.filter((e) =>
        ['reserved-identifier', 'banned-math', 'banned-literal', 'banned-async',
         'unsupported-syntax', 'invalid-type'].includes(e.rule));
    return blocking.length ? blocking[0] : null;
}

describe('VM_LINT_HARDENING lint rules ', function () {

    describe("66602d21: `**` / `**=` exponentiation ban", function () {
        const pow    = 'module.exports = function(x) { return 2 ** 10; };';
        const powEq  = 'module.exports = function(x) { var p = 2; p **= 3; return p; };';

        it('rejects ** under hardening (rule banned-math, directs to xchain.math.pow)', function () {
            const e = firstError(pow);
            assert.ok(e, 'expected a blocking error');
            assert.strictEqual(e.rule, 'banned-math');
            assert.ok(e.message.includes('banned operator: **'), e.message);
            assert.ok(e.message.includes('xchain.math.pow()'), e.message);
        });
        it('rejects **= under hardening', function () {
            const e = firstError(powEq);
            assert.ok(e && e.message.includes('banned operator: **='), e && e.message);
        });
        it('accepts both pre-gate (hardened=false, legacy replay parity)', function () {
            assert.strictEqual(firstError(pow,   { hardened: false }), null);
            assert.strictEqual(firstError(powEq, { hardened: false }), null);
        });
        it('findBannedExponentiation reports operator and line', function () {
            const hits = findBannedExponentiation('var a = 1;\nvar b = a ** 2;');
            assert.deepStrictEqual(hits, [{ op: '**', line: 2 }]);
        });
    });

    describe('5bff4687: reserved CONTRACT_WRAPPER control bindings', function () {
        for (const name of RESERVED_CONTROL_BINDINGS) {
            it('rejects a reference to ' + name + ' under hardening', function () {
                const code = 'module.exports = function(x) { return ' + name + '; };';
                const e = firstError(code);
                assert.ok(e, 'expected a blocking error');
                assert.strictEqual(e.rule, 'reserved-identifier');
                assert.strictEqual(e.message, 'reserved identifier: ' + name);
                // legacy replay parity: accepted pre-gate
                assert.strictEqual(firstError(code, { hardened: false }), null);
            });
        }
        it('rejects shadowing (let __methodName = ...) under hardening', function () {
            const code = 'module.exports = { m: function(x) { let __methodName = "spoof"; return __methodName; } };';
            assert.strictEqual(findReservedControlBinding(code), '__methodName');
            assert.ok(firstError(code));
        });
    });

    describe('71002d13: BANNED_MATH_MEMBERS derived from the SAFE_MATH complement', function () {
        it('SAFE_MATH_MEMBERS matches the frozen golden whitelist', function () {
            assert.deepStrictEqual([...SAFE_MATH_MEMBERS].sort(),
                ['E', 'PI', 'abs', 'ceil', 'floor', 'max', 'min', 'round', 'sign', 'trunc']);
        });
        it('SAFE_MATH_MEMBERS is byte-equal to the sandbox whitelist (vendored twin guard)', function () {
            let sandbox;
            try {
                sandbox = require('../../src/sandbox.js');
            } catch (e) {
                // sandbox.js requires isolated-vm (Node 22 / Linux); the golden
                // test above still pins the list where the isolate can't load.
                return this.skip();
            }
            assert.deepStrictEqual([...SAFE_MATH_MEMBERS].sort(), [...sandbox.SAFE_MATH_MEMBERS].sort(),
                'lint-core SAFE_MATH_MEMBERS drifted from sandbox.js; update both in lockstep');
        });
        it('rejects Math.random under hardening, accepts it pre-gate', function () {
            const code = 'module.exports = function(x) { return Math.random(); };';
            const e = firstError(code);
            assert.ok(e && e.rule === 'banned-math' && e.message.includes('Math.random'), e && e.message);
            assert.strictEqual(firstError(code, { hardened: false }), null);
        });
        it("rejects computed access Math['atan2'] under hardening", function () {
            const e = firstError("module.exports = function(x) { return Math['atan2'](1, 2); };");
            assert.ok(e && e.message.includes('Math.atan2'), e && e.message);
        });
        it('keeps the transcendental message for Math.pow in both modes', function () {
            const code = 'module.exports = function(x) { return Math.pow(2, 3); };';
            for (const opts of [undefined, { hardened: false }]) {
                const e = firstError(code, opts);
                assert.ok(e && e.message.includes('IEEE 754 floating-point transcendentals'), e && e.message);
            }
        });
        it('accepts every whitelisted SafeMath member in both modes', function () {
            for (const m of SAFE_MATH_MEMBERS) {
                const code = 'module.exports = function(x) { return Math.' + m +
                    (m === 'PI' || m === 'E' ? '' : '(1)') + '; };';
                assert.strictEqual(firstError(code), null, 'Math.' + m + ' must stay allowed');
                assert.strictEqual(firstError(code, { hardened: false }), null);
            }
        });
    });

    describe('8fa7043e: dynamic import() rejection', function () {
        const code = 'module.exports = function(x) { var p = import("fs"); return 1; };';
        it("rejects import() under hardening (rule banned-async, kind 'import')", function () {
            const hits = findBannedAsync(code, true);
            assert.deepStrictEqual(hits, [{ kind: 'import', line: 1 }]);
            const e = firstError(code);
            assert.ok(e && e.rule === 'banned-async' && e.message.includes('import'), e && e.message);
        });
        it('accepts import() pre-gate (legacy replay parity)', function () {
            assert.deepStrictEqual(findBannedAsync(code, false), []);
            assert.strictEqual(firstError(code, { hardened: false }), null);
        });
    });

    describe('efc8c624: shorthand { Promise } residual (locked-in rejection)', function () {
        // Acorn materializes distinct key/value nodes for a shorthand property,
        // so the value read is caught in BOTH modes at HEAD; these tests lock
        // the rejection in against a future walker/skip regression.
        const code = 'module.exports = function(x) { var o = { Promise }; return o; };';
        it('rejects the shorthand property under hardening', function () {
            const hits = findBannedAsync(code, true);
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].kind, 'promise');
        });
        it('rejects it pre-gate too (historical verdict, replay parity)', function () {
            assert.strictEqual(findBannedAsync(code, false).length, 1);
        });
        it('rejects globalThis.Promise in both modes (locked in)', function () {
            const g = 'module.exports = function(x) { return globalThis.Promise; };';
            assert.strictEqual(findBannedAsync(g, true).length, 1);
            assert.strictEqual(findBannedAsync(g, false).length, 1);
        });
        it('still accepts the explicit non-global key form { Promise: 1 } in both modes', function () {
            const ok = 'module.exports = function(x) { var o = { Promise: 1 }; return o.Promise; };';
            assert.deepStrictEqual(findBannedAsync(ok, true), []);
            assert.deepStrictEqual(findBannedAsync(ok, false), []);
        });
    });

    describe('c3dbbed1: shadowed-local Promise relaxation', function () {
        const cases = {
            'function parameter':  'module.exports = function(Promise) { return Promise; };',
            'let declaration':     'module.exports = function(x) { let Promise = 1; return Promise; };',
            'var declaration':     'module.exports = function(x) { var Promise = 2; return Promise + 1; };',
            'function declaration':'module.exports = function(x) { function Promise() { return 3; } return Promise(); };',
            'catch binding':       'module.exports = function(x) { try { return 1; } catch (Promise) { return Promise; } };',
            'for-of binding':      'module.exports = function(x) { for (const Promise of [1]) { return Promise; } };'
        };
        for (const [what, code] of Object.entries(cases)) {
            it('accepts a ' + what + ' shadow under hardening', function () {
                assert.deepStrictEqual(findBannedAsync(code, true), [], what);
            });
            it('still rejects the ' + what + ' shadow pre-gate (legacy over-reject preserved)', function () {
                assert.ok(findBannedAsync(code, false).length >= 1, what);
            });
        }
        it('accepts a destructured-parameter shadow under hardening (body read of the local)', function () {
            // The pattern's own `{ Promise }` shorthand is skipped by the legacy
            // key-skip too (same node is key and value), so BOTH modes accept the
            // declaration site; hardening additionally accepts the body read.
            const code = 'module.exports = function({ Promise }) { return Promise; };';
            assert.deepStrictEqual(findBannedAsync(code, true), []);
        });
        it('still rejects a genuinely global Promise reference in both modes', function () {
            const code = 'module.exports = function(x) { return Promise; };';
            assert.strictEqual(findBannedAsync(code, true).length, 1);
            assert.strictEqual(findBannedAsync(code, false).length, 1);
        });
        it('rejects a global reference outside the shadowing scope (sibling block does not leak)', function () {
            const code = 'module.exports = function(x) { { let Promise = 1; } return Promise; };';
            assert.strictEqual(findBannedAsync(code, true).length, 1);
        });
        it('still rejects globalThis.Promise even when a local Promise is in scope', function () {
            const code = 'module.exports = function(Promise) { return globalThis.Promise; };';
            assert.strictEqual(findBannedAsync(code, true).length, 1);
        });
    });

    describe('gating surface', function () {
        it('lintSource defaults to hardened (author-facing callers always see the rules)', function () {
            const e = firstError('module.exports = function(x) { return 2 ** 8; };');
            assert.ok(e, 'default must apply the hardened rule set');
        });
        it('findBannedMathCalls defaults to hardened', function () {
            assert.strictEqual(findBannedMathCalls('Math.random()').length, 1);
            assert.strictEqual(findBannedMathCalls('Math.random()', false).length, 0);
        });
    });
});
