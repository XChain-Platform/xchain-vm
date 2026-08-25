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
 * REST_PATTERN_METER deploy-lint rule: banned-rest.
 *
 * The allocator meter charges a destructuring rest by wrapping its SOURCE
 * EXPRESSION in a size-charged helper. Four rest positions have no source
 * expression to wrap -- a parameter list, a rest nested inside another pattern,
 * a catch-clause rest, and a for-of/for-in head -- so their O(n) copy would stay
 * free. Rejecting exactly those at deploy is what makes the metering rewrite
 * CLOSE the free-copy class rather than relocate it.
 *
 * Two-way, mirroring lint-generator-wasm.test.js:
 *   - the acorn-only detector + lintSource always emit the error-severity finding
 *     (author-facing SDK/CLI parity), and the rule is a CONSENSUS_RULE;
 *   - validateSyntax gates it on enforceBannedRest: OFF reproduces the
 *     pre-flag-day verdict (accepted, byte-identical replay), ON rejects.
 *
 * The complement matters as much as the rule: a rest that DOES have an
 * addressable source must NOT be rejected, because it is metered instead. If the
 * two predicates drift apart, either a metered form is rejected (a language
 * restriction nobody approved) or an unmeterable form is accepted (the hole
 * stays open), so both directions are pinned here.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource, findBannedRest, CONSENSUS_RULES } = require('../../src/lint-core.js');

// isolated-vm-dependent deploy validator (Node 22 only); guarded like the sibling
// suites so the acorn-only assertions still run where the isolate can't dlopen.
let validateSyntax = null;
try { ({ validateSyntax } = require('../../src/syntax.js')); } catch (e) { /* no isolate */ }

function firstConsensusError(code) {
    const errs = lintSource(code).errors.filter((e) => CONSENSUS_RULES.has(e.rule));
    return errs.length ? errs[0] : null;
}

describe('REST_PATTERN_METER deploy-lint: banned-rest', function () {

    it('banned-rest is a consensus rule (deploy-blocking, error severity)', function () {
        assert.ok(CONSENSUS_RULES.has('banned-rest'));
    });

    describe('UNMETERABLE rest positions are flagged', function () {
        const cases = {
            'function-declaration rest param': ['function f(...a){ return a.length; }', 'rest parameter'],
            'function-expression rest param':  ['var f = function(...a){ return a; };', 'rest parameter'],
            'arrow rest param':                ['var f = (...a) => a.length;', 'rest parameter'],
            'method-shorthand rest param':     ['var o = { m(...a){ return a; } };', 'rest parameter'],
            'class-method rest param':         ['class C { m(...a){ return a; } }', 'rest parameter'],
            'rest nested in an array pattern': ['var [[...c]] = a;', 'nested rest'],
            'rest nested in an object pattern':['var {a: {...c}} = o;', 'nested rest'],
            'rest nested under a top-level rest': ['var {a: [...z], ...r} = o;', 'nested rest'],
            'rest inside a param pattern':     ['function f([x, ...c]){ return c; }', 'rest parameter'],
            'catch-clause rest':               ['try { f(); } catch ({...e}) { g(e); }', 'catch-clause rest'],
            'for-of head rest (declaration)':  ['for (var [...c] of xs) { f(c); }', 'for-loop-head rest'],
            'for-of head rest (assignment)':   ['for ([...c] of xs) { f(c); }', 'for-loop-head rest'],
            'for-in head rest':                ['for (var [...c] in xs) { f(c); }', 'for-loop-head rest']
        };
        for (const [name, [code, kind]] of Object.entries(cases)) {
            it(name + ' → banned-rest (' + kind + ')', function () {
                const hits = findBannedRest(code);
                assert.strictEqual(hits.length, 1, name + ' should produce one hit: ' + JSON.stringify(hits));
                assert.strictEqual(hits[0].kind, kind, name + ' misclassified as ' + hits[0].kind);
                const err = firstConsensusError(code);
                assert.ok(err && err.rule === 'banned-rest',
                    name + ' must be deploy-blocking, got: ' + JSON.stringify(err));
                assert.strictEqual(err.severity, 'error');
                assert.match(err.message, /unmeterable rest pattern/);
            });
        }
    });

    describe('METERABLE rest positions are NOT flagged (they are charged instead)', function () {
        const ok = [
            'var [x, ...c] = a;',
            'var {k, ...c} = o;',
            'var [...c] = a;',
            'var {...c} = o;',
            '[a, ...c] = x;',
            '({k, ...c} = o);',
            'var [a, ...c] = x, [d, ...e] = y;',
            'var {a = 1, ...r} = o;',
            'function f(){ var [x, ...c] = a; return c; }'
        ];
        for (const code of ok) {
            it(JSON.stringify(code) + ' is accepted', function () {
                assert.deepStrictEqual(findBannedRest(code), [], 'must not be flagged: ' + code);
                assert.strictEqual(firstConsensusError(code), null, 'must not be deploy-blocking: ' + code);
            });
        }
    });

    describe('non-rest code is untouched', function () {
        for (const code of ['var [x, y] = a;', 'var {k, j} = o;', 'var b = [...a, 3];',
            'var m = {...base, k: 1};', 'f(...x);', 'function f(a, b){ return a + b; }']) {
            it(JSON.stringify(code) + ' produces no banned-rest finding', function () {
                assert.deepStrictEqual(findBannedRest(code), []);
            });
        }
    });

    it('a rest inside an OBJECT pattern is seen at all (acorn-walk blind spot)', function () {
        // acorn-walk's ObjectPattern base descends straight into a rest property's
        // ARGUMENT and never visits the RestElement, and CatchClause inherits that gap
        // through its param. A walk.ancestor-based detector therefore reports ZERO hits
        // for both of these while happily flagging the array-pattern equivalents, which
        // reads as "the rule works". Pin the two shapes that expose it.
        assert.strictEqual(findBannedRest('var {a: {...c}} = o;').length, 1,
            'object-pattern nested rest must be visible');
        assert.strictEqual(findBannedRest('try { f(); } catch ({...e}) { g(e); }').length, 1,
            'catch-clause object rest must be visible');
    });

    it('a syntactically invalid source yields no hits (the parse error is reported elsewhere)', function () {
        assert.deepStrictEqual(findBannedRest('function ('), []);
    });

    (validateSyntax ? describe : describe.skip)('validateSyntax gating (enforceBannedRest)', function () {
        const BAD = 'module.exports = function(){ function s(...n){ return n.length; } return s(1,2); };';

        it('enforceBannedRest ON rejects (post-flag-day verdict)', function () {
            const r = validateSyntax(BAD, { enforceBannedRest: true });
            assert.strictEqual(r.valid, false);
            assert.match(r.error, /unmeterable rest pattern: rest parameter/);
        });

        it('enforceBannedRest OFF accepts (pre-flag-day verdict, byte-identical replay)', function () {
            const r = validateSyntax(BAD, { enforceBannedRest: false });
            assert.strictEqual(r.valid, true, 'below the flag-day this contract was accepted: ' + r.error);
        });

        it('defaults to ON for author-facing callers (SDK/CLI linter, unit tests)', function () {
            assert.strictEqual(validateSyntax(BAD).valid, false);
        });

        it('a METERED rest deploys on both sides of the gate', function () {
            const GOOD = 'module.exports = function(){ var a = [1,2,3]; var [x, ...c] = a; return x + c.length; };';
            assert.strictEqual(validateSyntax(GOOD, { enforceBannedRest: true }).valid, true);
            assert.strictEqual(validateSyntax(GOOD, { enforceBannedRest: false }).valid, true);
        });
    });
});
