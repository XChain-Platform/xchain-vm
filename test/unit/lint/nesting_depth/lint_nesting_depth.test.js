/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    CONSENSUS_RULES,
    MAX_NESTING_DEPTH,
    findNestingDepth,
    lintSource
} = require('../../../../src/lint-core.js');
const { validateSyntax } = require('../../../../src/syntax.js');
const identityPin = require('../../../../bin/pins/identity.json');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function parenthesized(depth) {
    return 'module.exports = ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + ';';
}

function depthErrors(code, opts) {
    return lintSource(code, opts).errors.filter((error) => error.rule === 'nesting-depth');
}

describe('deploy-lint: nesting-depth', function () {
    it('matches the pinned companion SDK lint vendor byte for byte', function () {
        const entry = identityPin.files['src/lint-core.js'];
        assert.match(entry.sdkCommit, /^[0-9a-f]{40}$/);
        const commonGitDir = childProcess.execFileSync(
            'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            { cwd: REPO_ROOT, encoding: 'utf8' }
        ).trim();
        const sdkRoot = path.resolve(commonGitDir, '..', '..', 'xchain-sdk');
        const canonicalFiles = ['src/lint-core.js'].concat(
            fs.readdirSync(path.join(REPO_ROOT, 'src/lint-core')).sort()
                .map((name) => 'src/lint-core/' + name)
        );

        for (const rel of canonicalFiles) {
            const sdkPath = rel.replace(/^src\//, 'src/contract/');
            const vendored = childProcess.execFileSync(
                'git', ['-C', sdkRoot, 'show', entry.sdkCommit + ':' + sdkPath]
            );
            assert.deepStrictEqual(vendored, fs.readFileSync(path.join(REPO_ROOT, rel)), sdkPath);
        }
    });

    it('freezes the rule and limit as consensus parameters', function () {
        assert.ok(CONSENSUS_RULES.has('nesting-depth'));
        assert.strictEqual(MAX_NESTING_DEPTH, 64);
    });

    it('accepts the limit and rejects the first token beyond it', function () {
        assert.deepStrictEqual(findNestingDepth(parenthesized(64)), []);
        assert.deepStrictEqual(findNestingDepth(parenthesized(65)), [{ line: 1, depth: 65 }]);
    });

    it('reports the line of the first excessive opening token', function () {
        const source = 'module.exports =\n' + '('.repeat(64) + '\n(1)' + ')'.repeat(64) + ';';
        assert.deepStrictEqual(findNestingDepth(source), [{ line: 3, depth: 65 }]);
        assert.strictEqual(depthErrors(source)[0].line, 3);
    });

    it('counts mixed delimiters and template substitutions', function () {
        const openings = Array.from({ length: 17 }, () => '([{`x${').join('');
        const closings = Array.from({ length: 17 }, () => '}' + '`' + '}])').join('');
        const source = 'module.exports = ' + openings + '1' + closings + ';';
        assert.deepStrictEqual(findNestingDepth(source), [{ line: 1, depth: 65 }]);
    });

    it('ignores delimiter text in comments, strings, regexes and template chunks', function () {
        const source = [
            'var a = "(((([[[{{{";',
            'var b = /[(){}\\[\\]]+/;',
            'var c = `((([[{{ plain text`;',
            '// ((( [[[ {{{',
            'module.exports = a + b.source + c;'
        ].join('\n');
        assert.deepStrictEqual(findNestingDepth(source), []);
        assert.deepStrictEqual(depthErrors(source), []);
    });
});

describe('deploy-lint: nesting-depth enforcement', function () {
    it('returns before recursive parsing can overflow on hostile depth', function () {
        const source = parenthesized(20000);
        assert.doesNotThrow(() => lintSource(source));
        assert.strictEqual(lintSource(source).errors[0].rule, 'nesting-depth');
    });

    it('leaves lexical and parse failures to the existing syntax rules', function () {
        assert.deepStrictEqual(findNestingDepth('function f( {'), []);
        assert.strictEqual(lintSource('function f( {').errors[0].rule, 'unsupported-syntax');
    });

    it('is enabled by default and can be disabled for replay', function () {
        const source = parenthesized(65);
        assert.strictEqual(depthErrors(source).length, 1);
        assert.deepStrictEqual(depthErrors(source, { enforceLintNestingDepth: false }), []);
        assert.strictEqual(validateSyntax(source).valid, false);
        assert.strictEqual(validateSyntax(source, { enforceLintNestingDepth: false }).valid, true);
    });

    it('keeps validateSyntax and lintSource messages byte-identical', function () {
        const source = parenthesized(65);
        const lint = lintSource(source).errors[0];
        const deploy = validateSyntax(source);
        assert.strictEqual(deploy.valid, false);
        assert.strictEqual(deploy.error, lint.message);
        assert.strictEqual(lint.message, 'nesting depth exceeds limit (64) at line 1');
    });
});
