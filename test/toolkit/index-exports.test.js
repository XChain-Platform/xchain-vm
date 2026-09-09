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
 * The toolkit index is the surface `require('xchain-vm/toolkit')` sees. The
 * contract-meta walk behind the `contract-meta` gate rule lived only inside
 * gate.js, so a tool that consumed the toolkit could run the gate but not read
 * a source's declared identity on its own. Pin the two exports so they cannot
 * silently fall off the index again.
 ********************************************************************/
'use strict';

const assert  = require('assert');
const toolkit = require('../../src/toolkit');

describe('toolkit index re-exports the contract-meta walk', function () {
    it('exposes getExportedMeta and isValidMetaText as functions', function () {
        assert.strictEqual(typeof toolkit.getExportedMeta, 'function');
        assert.strictEqual(typeof toolkit.isValidMetaText, 'function');
    });

    it('getExportedMeta off the index reads a literal meta block', function () {
        const read = toolkit.getExportedMeta(
            "module.exports = { meta: { name: 'Ping', description: 'Returns ok', version: '1.0.0' }, permissions: [] };");
        assert.strictEqual(read.status, 'present');
        assert.strictEqual(read.name, 'Ping');
        assert.strictEqual(read.description, 'Returns ok');
        assert.strictEqual(read.version, '1.0.0');
    });

    it('isValidMetaText off the index applies the consensus grammar', function () {
        assert.strictEqual(toolkit.isValidMetaText('Escrow', 64, false), true);
        assert.strictEqual(toolkit.isValidMetaText('', 64, false), false);
        assert.strictEqual(toolkit.isValidMetaText(' padded', 64, false), false);
    });
});
