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
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    lintSource,
    findBannedAsync,
    findBannedWasm,
    findBannedMathCalls
} = require('../../../../src/lint-core.js');

const corpus = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../fixtures/lint/destructure_corpus.json'), 'utf8'
));
const sourceRules = (source, opts) => lintSource(source, opts).errors.map((finding) => finding.rule);

describe('LINT_DESTRUCTURE ObjectPattern refinement', function () {
    for (const entry of corpus.cases) {
        it('applies active and legacy verdicts for: ' + entry.source, function () {
            assert.deepStrictEqual(sourceRules(entry.source), entry.activeRules);
            assert.deepStrictEqual(sourceRules(entry.source, { destructure: false }), entry.legacyRules);
            if (entry.aliasOffRules)
                assert.deepStrictEqual(sourceRules(entry.source, { globalAlias: false }), entry.aliasOffRules);
        });
    }
});

describe('LINT_DESTRUCTURE ObjectPattern scanner hits', function () {
    const cases = [
        [findBannedAsync, 'const { Promise: LocalPromise } = globalThis;', [{ kind: 'promise', line: 1 }]],
        [findBannedAsync, 'const { Promise: { resolve } } = globalThis;', [{ kind: 'promise', line: 1 }]],
        [findBannedWasm, 'const { WebAssembly: Wasm } = globalThis;', [{ line: 1 }]],
        [findBannedWasm, 'const { WebAssembly: { compile } } = globalThis;', [{ line: 1 }]],
        [findBannedMathCalls, 'const { pow: deterministicPow } = Math;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedMathCalls, 'const { pow: { call } } = Math;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedMathCalls, 'const { Math: { pow: { call } } } = globalThis;',
            [{ name: 'pow', line: 1, transcendental: true }]],
        [findBannedAsync, '({ Promise: localPromise } = globalThis);', [{ kind: 'promise', line: 1 }]],
        [findBannedWasm, '({ WebAssembly: wasm } = globalThis);', [{ line: 1 }]],
        [findBannedMathCalls, '({ log: deterministicLog } = globalThis.Math);',
            [{ name: 'log', line: 1, transcendental: true }]]
    ];
    for (const [scan, source, expected] of cases) {
        it('reports the static property read in ' + source, function () {
            assert.deepStrictEqual(scan(source), expected);
        });
    }
});

describe('LINT_DESTRUCTURE ObjectPattern flag composition', function () {
    it('keeps each scanner byte-for-byte legacy when destructure is false', function () {
        assert.deepStrictEqual(findBannedAsync(
            'const { Promise: LocalPromise } = globalThis;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedWasm(
            'const { WebAssembly: Wasm } = globalThis;', true, true, false), []);
        assert.deepStrictEqual(findBannedMathCalls(
            'const { pow: deterministicPow } = Math;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedAsync(
            'const { Promise: { resolve } } = globalThis;', true, true, true, false), []);
        assert.deepStrictEqual(findBannedWasm(
            'const { WebAssembly: { compile } } = globalThis;', true, true, false), []);
        assert.deepStrictEqual(findBannedMathCalls(
            'const { pow: { call } } = Math;', true, true, true, false), []);
    });

    it('does not treat safe, dynamic, or unrelated properties as banned reads', function () {
        const clean = [
            'const { floor: deterministicFloor } = Math;',
            'const { floor: { call } } = Math;',
            'const key = "pow"; const { [key]: localPow } = Math;',
            'const key = "Math"; const { [key]: { pow: localPow } } = globalThis;',
            'const { pow: localPow } = other;',
            'const { safe: { Promise: LocalPromise } } = globalThis;',
            'const { Promise: LocalPromise, WebAssembly: Wasm } = other;'
        ];
        for (const source of clean)
            assert.deepStrictEqual(sourceRules(source), [], 'unexpected finding for: ' + source);
    });

    it('composes aliases and optional chains only under their own flags', function () {
        const alias = 'const { globalThis: { Promise: LocalPromise } } = globalThis;';
        assert.deepStrictEqual(sourceRules(alias), ['banned-async']);
        assert.deepStrictEqual(sourceRules(alias, { globalAlias: false }), []);
        const optional = 'const { Math: { pow: deterministicPow } } = (globalThis?.globalThis);';
        assert.deepStrictEqual(sourceRules(optional), ['banned-math']);
        assert.deepStrictEqual(sourceRules(optional, { optionalChain: false }), []);
    });
});
