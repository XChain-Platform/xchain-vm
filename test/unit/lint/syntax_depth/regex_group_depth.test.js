/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Gated regex group-depth bound.
 ********************************************************************/
'use strict';

const assert = require('assert');
const XChainVM = require('../../../../src/index.js');
const { lintSource, regexGroupDepthFinding, MAX_REGEX_GROUP_DEPTH } = require('../../../../src/lint-core.js');
const { regexGroupDepth } = require('../../../../src/lint-core/regex_group_depth.js');
const { validateSyntax } = require('../../../../src/syntax.js');

const wrap = (body) => 'module.exports = function(xchain) {\n' + body + '\nreturn 1;\n};';
const nestedRegex = (n) => 'var x = /' + '('.repeat(n) + 'a' + ')'.repeat(n) + '/;';
const REFUSAL = 'regex group depth exceeds limit (64) at line 2';
const BANNED_REGEX = 'banned literal: regex literal at line 2; regular-expression literals ' +
    'can backtrack catastrophically and are unmetered';

const ARMED = {
    enforceBannedAsync: true, enforceLintHardening: true, enforceBannedGenerator: true,
    enforceBannedWasm: true, enforceLintGlobalAlias: true, enforceLintOptionalChain: true,
    enforceBannedWith: true, enforceLintNestingDepth: true, enforceLintDestructure: true,
    enforceBannedRest: true, enforceLintSyntaxDepth: true, enforceLintRegexGroupDepth: true
};
const UNARMED = Object.fromEntries(Object.keys(ARMED).map((key) => [key, false]));

describe('deploy-lint: gated regex group depth', function () {
    this.timeout(30000);

    it('freezes the bound and activation table', function () {
        assert.strictEqual(MAX_REGEX_GROUP_DEPTH, 64);
        assert.deepStrictEqual(XChainVM.LINT_REGEX_GROUP_DEPTH_ACTIVATION, {
            mainnet: null, testnet: 1794873600, regtest: 0
        });
        assert.strictEqual(XChainVM.isLintRegexGroupDepthActive('testnet', 1794873599), false);
        assert.strictEqual(XChainVM.isLintRegexGroupDepthActive('testnet', 1794873600), true);
        assert.strictEqual(XChainVM.isLintRegexGroupDepthActive('regtest', 0), true);
        assert.strictEqual(XChainVM.isLintRegexGroupDepthActive('mainnet', 9999999999), false);
    });

    it('counts only unescaped group parens outside a character class', function () {
        assert.strictEqual(regexGroupDepth('((a)|(b))'), 2);
        assert.strictEqual(regexGroupDepth('(?:(?=(?<n>a)))'), 3);
        assert.strictEqual(regexGroupDepth('[(((]'), 0);
        assert.strictEqual(regexGroupDepth('\\(\\(\\('), 0);
        assert.strictEqual(regexGroupDepth('[\\]((]((a))'), 2);
    });

    it('keeps the historical 65-group verdict before activation', function () {
        const code = wrap(nestedRegex(MAX_REGEX_GROUP_DEPTH + 1));
        assert.deepStrictEqual(validateSyntax(code, UNARMED), { valid: false, error: BANNED_REGEX });
        assert.strictEqual(lintSource(code, {
            enforceLintNestingDepth: false,
            enforceLintSyntaxDepth: false,
            enforceLintRegexGroupDepth: false
        }).errors[0].message, BANNED_REGEX);
    });

    it('refuses one level over the bound after activation', function () {
        assert.deepStrictEqual(validateSyntax(wrap(nestedRegex(MAX_REGEX_GROUP_DEPTH)), ARMED),
            { valid: false, error: BANNED_REGEX });
        assert.deepStrictEqual(validateSyntax(wrap(nestedRegex(MAX_REGEX_GROUP_DEPTH + 1)), ARMED),
            { valid: false, error: REFUSAL });
    });

    it('returns the pinned refusal instead of a host fault for a hostile body', function () {
        const code = wrap(nestedRegex(8000));
        assert.deepStrictEqual(validateSyntax(code, ARMED), { valid: false, error: REFUSAL });
        assert.deepStrictEqual(validateSyntax(code), { valid: false, error: REFUSAL });
        assert.deepStrictEqual(regexGroupDepthFinding(code), {
            rule: 'nesting-depth', message: REFUSAL, line: 2, severity: 'error'
        });
    });

    it('keeps an earlier depth refusal ahead of a later deep regex', function () {
        const delimiters = wrap('var y = ' + '['.repeat(70) + ']'.repeat(70) + ';\n' + nestedRegex(8000));
        assert.match(validateSyntax(delimiters, ARMED).error,
            /^nesting depth exceeds limit \(64\) at line 2$/);
        const syntax = wrap('var y = ' + '!'.repeat(300) + '1;\n' + nestedRegex(8000));
        assert.match(validateSyntax(syntax, ARMED).error,
            /^syntax depth exceeds limit \(200\) at line 2$/);
    });

    it('reports the regex line and ignores parens outside regex groups', function () {
        const many = '('.repeat(200);
        const safe = wrap('var s = "' + many + '"; // ' + many + '\nvar r = /[' + many + ']\\(\\(/;');
        assert.strictEqual(regexGroupDepthFinding(safe), null);
        const code = wrap('var a = 1;\nvar b = 2;\n' + nestedRegex(8000));
        assert.deepStrictEqual(validateSyntax(code, ARMED), {
            valid: false, error: 'regex group depth exceeds limit (64) at line 4'
        });
    });
});
