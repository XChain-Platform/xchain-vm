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
 * Toolkit gate: the meta-text code-point tables (isBannedMetaCodePoint,
 * isMetaEdgeCodePoint) in isolation from the rest of the gate.
 *
 * Requires meta_validation.js directly, never the toolkit index, so this
 * suite stays runnable where isolated-vm cannot dlopen.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { isBannedMetaCodePoint, isMetaEdgeCodePoint } = require('../../src/toolkit/gate/meta_validation.js');

describe('Toolkit gate: meta text code-point tables', function () {

    describe('isBannedMetaCodePoint', function () {
        it('bans LF (U+000A) when allowLf is false', function () {
            assert.strictEqual(isBannedMetaCodePoint(0x0A, false), true);
        });

        it('allows LF (U+000A) when allowLf is true', function () {
            assert.strictEqual(isBannedMetaCodePoint(0x0A, true), false);
        });

        it('bans the word joiner (U+2060)', function () {
            assert.strictEqual(isBannedMetaCodePoint(0x2060, false), true);
        });

        it('does not ban an ordinary ASCII letter (U+0041)', function () {
            assert.strictEqual(isBannedMetaCodePoint(0x41, false), false);
        });
    });

    describe('isMetaEdgeCodePoint', function () {
        it('treats the ASCII space (U+0020) as an edge code point', function () {
            assert.strictEqual(isMetaEdgeCodePoint(0x20, false), true);
        });

        it('does not treat an ordinary ASCII letter (U+0041) as an edge code point', function () {
            assert.strictEqual(isMetaEdgeCodePoint(0x41, false), false);
        });
    });
});
