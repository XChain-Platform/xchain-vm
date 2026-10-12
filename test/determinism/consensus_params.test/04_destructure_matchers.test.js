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
const lintCore = require('../../../src/lint-core.js');

describe('consensus parameters are frozen (track 8 guard)', function () {
    it('deploy global and Math matchers include gated ObjectPattern reads', function () {
        assert.deepStrictEqual(
            lintCore.findBannedAsync('const { Promise: LocalPromise } = globalThis;'),
            [{ kind: 'promise', line: 1 }]
        );
        assert.deepStrictEqual(
            lintCore.findBannedWasm('const { WebAssembly: Wasm } = globalThis;'),
            [{ line: 1 }]
        );
        assert.deepStrictEqual(
            lintCore.findBannedMathCalls('const { Math: { pow: deterministicPow } } = globalThis;'),
            [{ name: 'pow', line: 1, transcendental: true }]
        );
        assert.deepStrictEqual(
            lintCore.lintSource('const { Promise: P, WebAssembly: W, Math: { pow } } = globalThis;',
                { destructure: false }).errors,
            [],
            'the pre-activation ObjectPattern verdict must remain accepted'
        );
    });
});
