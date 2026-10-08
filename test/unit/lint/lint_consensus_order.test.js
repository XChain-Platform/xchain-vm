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
 * Pins the order lintSource returns consensus errors in. validateSyntax records
 * the first blocking error as the deploy verdict, so a reorder of the checks
 * changes recorded verdict strings and may only move behind a flag day.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { lintSource, CONSENSUS_RULES } = require('../../../src/lint-core.js');

let validateSyntax = null;
try { ({ validateSyntax } = require('../../../src/syntax.js')); } catch (e) { /* no isolate */ }

// A parameter rest has no source expression to meter, so it is banned-rest.
const REST_AND_WASM = 'module.exports = function(){ function s(...n){ return typeof WebAssembly; } return s(1); };';
const GEN_REST_WASM = REST_AND_WASM + ' function* g(){ yield 1; }';

// The consensus rules a source trips, in returned order, with repeats collapsed.
function consensusSequence(code) {
    const seq = [];
    for (const e of lintSource(code).errors) {
        if (CONSENSUS_RULES.has(e.rule) && seq[seq.length - 1] !== e.rule) seq.push(e.rule);
    }
    return seq;
}

describe('lint consensus error order is pinned', function () {

    it('returns banned-generator, then banned-rest, then banned-wasm', function () {
        assert.deepStrictEqual(consensusSequence(GEN_REST_WASM),
            ['banned-generator', 'banned-rest', 'banned-wasm']);
    });

    it('puts banned-rest ahead of banned-wasm when both fire', function () {
        assert.strictEqual(lintSource(REST_AND_WASM).errors[0].rule, 'banned-rest');
    });
});

(validateSyntax ? describe : describe.skip)('lint consensus error order is pinned', function () {

    it('records the banned-rest message once the rest gate is active', function () {
        const first = lintSource(REST_AND_WASM).errors[0];
        assert.strictEqual(validateSyntax(REST_AND_WASM).error, first.message);
    });

    it('records the banned-wasm message before the rest gate activates', function () {
        const wasm = lintSource(REST_AND_WASM).errors.find((e) => e.rule === 'banned-wasm');
        assert.ok(wasm, 'the fixture must also trip banned-wasm');
        assert.strictEqual(validateSyntax(REST_AND_WASM, { enforceBannedRest: false }).error, wasm.message);
    });
});
