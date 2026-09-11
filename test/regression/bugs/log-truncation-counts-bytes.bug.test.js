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
 * [BUG] Contract log truncation counted characters, not bytes
 *
 * The collector's 1024-limit was measured with String#length, so a
 * multi-byte message passed the check while carrying up to four times
 * the intended payload: 500 CJK characters are 500 "long" but 1500
 * bytes. Every validator serialises logs, so an unbounded byte length
 * is a block-size input, not a cosmetic one. Fixed by measuring with
 * Buffer.byteLength and cutting the buffer.
 *
 * Witness: a message that is UNDER the limit in characters and OVER it
 * in bytes must come back truncated.
 *
 * Run: npm run test:regression:bugfix
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../helpers.js');

const LIMIT_BYTES = 1024;
const SUFFIX      = '...(truncated)';

describe('[BUG] contract log truncation is measured in UTF-8 bytes', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('truncates a message under the character limit but over the byte limit', async function() {
        this.timeout(30000);
        // 500 x U+65E5 = 500 characters, 1500 UTF-8 bytes.
        const r = await execute(vm,
            "module.exports = function(xchain) { xchain.log('日'.repeat(500)); return 1; };");

        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.logs.length, 1);

        const logged = r.logs[0];
        assert(logged.endsWith(SUFFIX),
            'a 1500-byte message must be truncated even though it is only 500 characters long');
        // The cut lands mid-codepoint, so the last partial sequence decodes
        // to one replacement character: allow its 3 bytes over the limit.
        assert(Buffer.byteLength(logged, 'utf8') <= LIMIT_BYTES + 3 + Buffer.byteLength(SUFFIX, 'utf8'),
            'the kept prefix must be bounded in bytes, not in characters');
        assert(Buffer.byteLength(logged, 'utf8') < Buffer.byteLength('日'.repeat(500), 'utf8'),
            'the truncated log must be smaller than the message the contract wrote');
    });

    it('leaves a message that is under the byte limit intact', async function() {
        this.timeout(30000);
        // 300 x U+65E5 = 900 bytes: under the limit by either measure.
        const r = await execute(vm,
            "module.exports = function(xchain) { xchain.log('日'.repeat(300)); return 1; };");

        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.logs[0], '日'.repeat(300),
            'a message inside the byte limit must not be cut');
    });

    it('bounds an ASCII message that exceeds the byte limit', async function() {
        this.timeout(30000);
        const r = await execute(vm,
            "module.exports = function(xchain) { xchain.log('a'.repeat(4096)); return 1; };");

        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.logs[0], 'a'.repeat(LIMIT_BYTES) + SUFFIX);
    });
});
