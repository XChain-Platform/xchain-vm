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
const regexLiteral = (n) => '/' + '('.repeat(n) + 'a' + ')'.repeat(n) + '/';
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

function withOverflowAndMissedPreParse(stage, run) {
    const ivmPath = require.resolve('isolated-vm');
    const lintPath = require.resolve('../../../../src/lint-core.js');
    const syntaxPath = require.resolve('../../../../src/syntax.js');
    const saved = new Map([[ivmPath, require.cache[ivmPath]], [lintPath, require.cache[lintPath]],
        [syntaxPath, require.cache[syntaxPath]]]);
    const lint = require(lintPath);
    require.cache[ivmPath] = { id: ivmPath, filename: ivmPath, loaded: true, exports: {
        Isolate: function () {
            return {
                compileScriptSync: function () {
                    if (stage === 'compile') throw new RangeError('Maximum call stack size exceeded');
                },
                dispose: function () {}
            };
        }
    } };
    require.cache[lintPath] = { id: lintPath, filename: lintPath, loaded: true, exports: {
        ...lint,
        nestingDepthFinding: function () { return null; },
        syntaxDepthFinding: function () { return null; },
        lintSource: function () {
            if (stage === 'acorn') throw new RangeError('Maximum call stack size exceeded');
            return lint.lintSource.apply(this, arguments);
        }
    } };
    delete require.cache[syntaxPath];
    try {
        return run(require(syntaxPath));
    } finally {
        for (const [path, entry] of saved) {
            if (entry) require.cache[path] = entry;
            else delete require.cache[path];
        }
    }
}

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

    it('recognizes regex literals at every expression-start goal boundary', function () {
        const sources = goalBoundarySources(regexLiteral(MAX_REGEX_GROUP_DEPTH + 1));
        for (const [context, code] of Object.entries(sources)) {
            assert.deepStrictEqual(regexGroupDepthFinding(code), {
                rule: 'nesting-depth',
                message: 'regex group depth exceeds limit (64) at line 1',
                line: 1,
                severity: 'error'
            }, context);
        }
    });
});

// One source per expression-start context, each placing the regex literal `re`
// where the standalone tokenizer must choose between regex and division; await
// was the one context it misread before the grammar-goal fix.
function goalBoundarySources(re) {
    const tick = String.fromCharCode(96);
    return {
            await: 'async function f(){ await ' + re + '; }',
            yield: 'function* f(){ yield ' + re + '; }',
            typeof: 'typeof ' + re + ';',
            void: 'void ' + re + ';',
            delete: 'delete ' + re + '.x;',
            instanceof: 'x instanceof ' + re + ';',
            in: 'x in ' + re + ';',
            of: 'for (x of ' + re + ') {}',
            case: 'switch (x) { case ' + re + ': break; }',
            return: 'function f(){ return ' + re + '; }',
            throw: 'function f(){ throw ' + re + '; }',
            new: 'new ' + re + ';',
            do: 'do ' + re + '.test(x); while (false);',
            else: 'if (x) y(); else ' + re + '.test(x);',
            arrow: 'const f = () => ' + re + ';',
            blockClose: 'if (x) {} ' + re + '.test(x);',
            statementParenClose: 'if (x) ' + re + '.test(x);',
            templateExpression: 'const x = ' + tick + '${' + re + '}' + tick + ';',
            templateClose: 'const x = ' + tick + 'x' + tick + '; ' + re + '.test(x);',
            assignment: 'x = ' + re + ';',
            comma: 'x, ' + re + ';',
            propertyColon: '({ x: ' + re + ' });',
            conditional: 'x ? ' + re + ' : y;',
            logical: 'x && ' + re + ';',
            parenOpen: '(' + re + ');'
    };
}

// Same suite name as above, split only to keep each callback inside the
// 60-line function budget; the full test titles are unchanged.
describe('deploy-lint: gated regex group depth', function () {
    this.timeout(30000);

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

    it('returns the pinned refusal for a hostile regex following await', function () {
        const re = regexLiteral(1500);
        const code = 'async function f(){ await ' + re + '; }';
        assert.deepStrictEqual(validateSyntax(code, ARMED), {
            valid: false,
            error: 'regex group depth exceeds limit (64) at line 1'
        });
    });

    it('maps a confirmed validation overflow only while the regex gate is active', function () {
        const { HostFaultError } = require('../../../../src/errors.js');
        for (const stage of ['compile', 'acorn']) {
            withOverflowAndMissedPreParse(stage, (syntax) => {
                const code = 'async function f(){ await ' + regexLiteral(1500) + '; }';
                assert.deepStrictEqual(syntax.validateSyntax(code, ARMED), {
                    valid: false,
                    error: 'regex group depth exceeds limit (64) at line 1'
                }, stage);
                assert.throws(() => syntax.validateSyntax(code, {
                    ...ARMED,
                    enforceLintRegexGroupDepth: false
                }), (e) => e instanceof HostFaultError, stage);
                assert.throws(() => syntax.validateSyntax('var x = 1;', ARMED),
                    (e) => e instanceof HostFaultError, stage);
            });
        }
    });
});

describe('deploy-lint: gated regex group depth', function () {
    this.timeout(30000);

    it('keeps await identifiers followed by division out of the regex bound', function () {
        const groups = '('.repeat(MAX_REGEX_GROUP_DEPTH + 1) + 'x' +
            ')'.repeat(MAX_REGEX_GROUP_DEPTH + 1);
        const code = 'function f(await, d){ return await / ' + groups + ' / d; }';
        assert.strictEqual(regexGroupDepthFinding(code), null);
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
