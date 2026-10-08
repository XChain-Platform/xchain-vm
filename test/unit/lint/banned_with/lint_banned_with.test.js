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
 * Deploy-lint rule: banned-with.
 *
 * A `with` block rebinds free identifiers to an object at runtime, so it can
 * route a name the identifier-precise bans clear (a reserved helper, a stripped
 * global, a Math member) to an attacker-chosen property. The rule is an
 * error-severity CONSENSUS_RULE and must match the statement and nothing else.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { lintSource, findBannedWith, CONSENSUS_RULES } = require('../../../../src/lint-core.js');

const withErrors = (code) => lintSource(code).errors.filter((e) => e.rule === 'banned-with');

describe('deploy-lint: banned-with', function () {

    it('banned-with is a consensus rule', function () {
        assert.ok(CONSENSUS_RULES.has('banned-with'));
    });

    it('flags a with statement with its line', function () {
        const hits = findBannedWith('var o = {};\nwith (o) { a = 1; }');
        assert.deepStrictEqual(hits, [{ line: 2 }]);
    });

    it('flags every with statement, nested ones included', function () {
        assert.strictEqual(findBannedWith('with (a) { with (b) { c; } }').length, 2);
    });

    it('lintSource emits an error-severity finding carrying the line', function () {
        const errs = withErrors('function f(o){\n  with (o) { return x; }\n}');
        assert.strictEqual(errs.length, 1);
        assert.strictEqual(errs[0].severity, 'error');
        assert.strictEqual(errs[0].line, 2);
        assert.ok(/^banned statement: with at line 2;/.test(errs[0].message));
    });

    it('does not flag the word with in identifiers, properties, strings or comments', function () {
        const src = 'var withdraw = 1; var o = { with: 2 }; var s = "with (x) {}"; // with (y) {}\nfunction f(){ return o.with + withdraw; }';
        assert.deepStrictEqual(findBannedWith(src), []);
        assert.deepStrictEqual(withErrors(src), []);
    });

    it('yields no hits for unparseable source', function () {
        assert.deepStrictEqual(findBannedWith('with ('), []);
    });

    it('clean code has no banned-with finding', function () {
        assert.deepStrictEqual(withErrors('function add(a, b){ return a + b; }'), []);
    });
});
