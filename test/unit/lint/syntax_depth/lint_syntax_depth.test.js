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
 * Syntax-depth lint: the non-recursive bound over every construct the parsers and
 * the metering pass recurse on, its threading through deploy and execute-time lint,
 * and exact pre-activation parity.
 ********************************************************************/
'use strict';

const assert = require('assert');
const {
    lintSource, findSyntaxDepth, measureSyntaxDepth, MAX_SYNTAX_DEPTH, isHostStackOverflow
} = require('../../../../src/lint-core.js');
const { validateSyntax } = require('../../../../src/syntax.js');
const { createVM, execute } = require('../../../fuzz/helpers/harness.js');

const wrap = (body) => 'module.exports = function(xchain) {\n' + body + '\nreturn 1;\n};';
// Delimiter-free shapes the 64-delimiter scan cannot see, plus delimiter and mixed ones.
const SHAPES = {
    not: (n) => 'var x = ' + '!'.repeat(n) + '1;',
    assign: (n) => 'var a; var x = ' + 'a = '.repeat(n) + '1;',
    plus: (n) => 'var a = 1; var x = a' + ' + a'.repeat(n) + ';',
    ternary: (n) => 'var a = 1; var x = ' + 'a ? 1 : '.repeat(n) + '1;',
    typeofs: (n) => 'var x = ' + 'typeof '.repeat(n) + '1;',
    voids: (n) => 'var x = ' + 'void '.repeat(n) + '1;',
    elseif: (n) => 'var a = 1; ' + 'if (a) a = 1; else '.repeat(n) + 'a = 2;',
    elseifblk: (n) => 'var a = 1; ' + 'if (a) { a = 1; } else '.repeat(n) + '{ a = 2; }',
    ifif: (n) => 'var a = 1; ' + 'if (a) '.repeat(n) + 'a = 2;',
    labels: (n) => Array.from({ length: n }, (_, i) => 'l' + i + ': ').join('') + 'var q = 1;',
    dodo: (n) => 'var a = 0; ' + 'do '.repeat(n) + 'a = 1; ' + 'while (a); '.repeat(n),
    arrow: (n) => 'var f = ' + 'a => '.repeat(n) + '1;',
    calls: (n) => 'var f = function(){ return f; }; var x = f' + '()'.repeat(n) + ';',
    member: (n) => 'var o = {}; var x = function(){ return o' + '.b'.repeat(n) + '; };',
    callplus: (n) => 'var f = function(v){ return v; }; var x = f(1)' + ' + 1'.repeat(n) + ';',
    ifcomma: (n) => 'var a = 1; ' + 'if (a) '.repeat(n) + 'a = 2, a = !1;',
    array: (n) => 'var x = ' + '['.repeat(n) + ']'.repeat(n) + ';',
};
const REGTEST = { network: 'regtest', contractAddress: 'C:BTC:1', blockContext: { height: 100, timestamp: 4000000000, hash: 'h' } };
const MAINNET = { network: 'mainnet', contractAddress: 'C:BTC:1', blockContext: { height: 961000, timestamp: 4000000000, hash: 'h' } };
// The flags actions/deploy/lint.js resolves on regtest, where every row is active.
const REGTEST_DEPLOY = { enforceLintNestingDepth: true, enforceLintSyntaxDepth: true };
// Deploy flags while the syntax-depth row is unarmed and the nesting row is too.
const UNARMED_DEPLOY = { enforceLintNestingDepth: false, enforceLintSyntaxDepth: false };

// The smallest N whose source measures over the bound.
function firstRefusedN(shape) {
    let n = 1;
    while (measureSyntaxDepth(wrap(SHAPES[shape](n))) <= MAX_SYNTAX_DEPTH) n++;
    return n;
}

describe('deploy-lint: syntax depth', function () {
    this.timeout(60000);

    it('freezes the bound and reuses the nesting-depth consensus rule', function () {
        assert.strictEqual(MAX_SYNTAX_DEPTH, 200);
        assert.strictEqual(lintSource(wrap(SHAPES.not(400))).errors[0].rule, 'nesting-depth');
    });

    it('grows linearly in every shape, so no shape can nest without being counted', function () {
        for (const shape of Object.keys(SHAPES)) {
            const d = [10, 20, 40].map((n) => measureSyntaxDepth(wrap(SHAPES[shape](n))));
            assert.ok(d[1] > d[0] && d[2] - d[1] === 2 * (d[1] - d[0]), shape + ' ' + d);
        }
    });

    it('keeps flat code low however long it is', function () {
        const flat = [
            'var x = [' + Array.from({ length: 500 }, (_, i) => '-' + i).join(', ') + '];',
            'var a = 1;' + ' if (a) { a = 2; }'.repeat(300),
            'var o = {' + Array.from({ length: 200 }, (_, i) => 'm' + i + ': function(a){ return a + 1; }').join(', ') + '};',
            'var a = 1; switch (a) {' + Array.from({ length: 100 }, (_, i) => ' case ' + i + ': a = ' + i + '; break;').join('') + '}',
        ];
        for (const body of flat) assert.ok(measureSyntaxDepth(wrap(body)) < 40, body.slice(0, 40));
    });

    it('charges a left-deep chain that continues after a closed frame to that frame', function () {
        const inner = '[[[[[[[[[[1]]]]]]]]]]';
        const alone = measureSyntaxDepth(wrap('var x = ' + inner + ';'));
        const chained = measureSyntaxDepth(wrap('var x = ' + inner + ' + 1'.repeat(50) + ';'));
        assert.ok(chained >= alone + 50, alone + ' ' + chained);
    });

    it('carries a statement head across a comma and an else across a semicolon', function () {
        const commas = measureSyntaxDepth(wrap('var a = 1; ' + 'if (a) '.repeat(60) + 'a = 2, a = ' + '!'.repeat(60) + '1;'));
        assert.ok(commas > 60 + 60 + 60, String(commas));
        assert.ok(measureSyntaxDepth(wrap(SHAPES.elseif(60))) > 180);
        assert.ok(measureSyntaxDepth(wrap(SHAPES.dodo(60))) > 180);
    });

    it('measures a prefix the tokenizer cannot finish, since a parser recurses through it first', function () {
        assert.deepStrictEqual(findSyntaxDepth('var x = ' + '!'.repeat(50) + '@'), []);
        assert.strictEqual(findSyntaxDepth('var x = ' + '!'.repeat(400) + '@').length, 1);
    });

});

describe('deploy-lint: syntax depth refusals', function () {
    this.timeout(60000);

    it('refuses every shape at the first N over the bound and accepts the N below it', function () {
        for (const shape of Object.keys(SHAPES)) {
            const n = firstRefusedN(shape);
            const over = validateSyntax(wrap(SHAPES[shape](n)), REGTEST_DEPLOY);
            assert.strictEqual(over.valid, false, shape);
            assert.match(over.error, /^syntax depth exceeds limit \(200\) at line \d+$/, shape);
            if (shape !== 'array') assert.deepStrictEqual(validateSyntax(wrap(SHAPES[shape](n - 1)), REGTEST_DEPLOY), { valid: true }, shape);
        }
    });

    it('lintSource reports the same first error as validateSyntax', function () {
        for (const shape of ['not', 'elseif', 'arrow', 'calls']) {
            const code = wrap(SHAPES[shape](firstRefusedN(shape)));
            assert.strictEqual(lintSource(code).errors[0].message, validateSyntax(code).error, shape);
        }
    });

    it('makes deploy enforce the delimiter rule whatever the nesting flag says', function () {
        const code = 'module.exports = ' + '('.repeat(65) + '1' + ')'.repeat(65) + ';';
        assert.deepStrictEqual(validateSyntax(code, { enforceLintNestingDepth: false, enforceLintSyntaxDepth: true }),
            { valid: false, error: 'nesting depth exceeds limit (64) at line 1' });
        assert.deepStrictEqual(validateSyntax(code, UNARMED_DEPLOY), { valid: true });
    });

    it('leaves the unarmed deploy path untouched: a source over the bound is still judged by the old passes', function () {
        const code = wrap(SHAPES.not(250));
        assert.deepStrictEqual(validateSyntax(code, UNARMED_DEPLOY), { valid: true });
    });

    it('treats a host stack overflow in the parse step as a fault only when asked', function () {
        const code = wrap(SHAPES.not(60000));
        let thrown = null;
        try { lintSource(code, { enforceLintNestingDepth: false, enforceLintSyntaxDepth: false, overflowIsHostFault: true }); } catch (e) { thrown = e; }
        assert.ok(isHostStackOverflow(thrown), String(thrown));
        const legacy = lintSource(code, { enforceLintNestingDepth: false, enforceLintSyntaxDepth: false });
        assert.match(legacy.errors[0].message, /^unsupported syntax \(ES2020 maximum\): Maximum call stack size exceeded/);
    });
});

describe('execute-time lint: syntax depth', function () {
    this.timeout(60000);
    let vm;
    beforeEach(function () { vm = createVM({ maxCpuTimeMs: 5000 }); vm.beginBlock(); });
    afterEach(function () { vm.endBlock(); });

    it('agrees with the deploy verdict for every shape on either side of the bound', async function () {
        for (const shape of Object.keys(SHAPES)) {
            const n = firstRefusedN(shape);
            for (const m of [n - 1, n]) {
                const code = wrap(SHAPES[shape](m));
                const deploy = validateSyntax(code, REGTEST_DEPLOY);
                const run = await execute(vm, code, REGTEST);
                const refused = !run.success && /^error: banned syntax: /.test(run.error);
                assert.strictEqual(refused, !deploy.valid, shape + ' at ' + m + ': ' + run.error);
                if (!deploy.valid) assert.strictEqual(run.error, 'error: banned syntax: ' + deploy.error, shape);
            }
        }
    });

    it('keys the verdict cache on the syntax-depth bit and forwards it exactly', function () {
        const code = wrap(SHAPES.not(250));
        const off = vm.getLintVerdict(code, true, true, true, true, true, true, undefined, true, true, false);
        const on = vm.getLintVerdict(code, true, true, true, true, true, true, undefined, true, true, true);
        assert.strictEqual(vm._lintVerdictCache.size, 2);
        assert.strictEqual(on.valid, false);
        assert.match(on.error, /^syntax depth exceeds limit/);
        assert.ok(off.valid || !/^syntax depth/.test(off.error));
    });

    it('does not apply the bound on an unarmed network', async function () {
        const run = await execute(vm, wrap(SHAPES.not(250)), MAINNET);
        assert.ok(run.success || !/syntax depth/.test(String(run.error)), String(run.error));
    });
});
