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
 * The contract.slash amount forms are built from the ceilings in
 * src/gateway/slash_limits.js. Their exact source strings are consensus: a
 * changed form changes which slash calls emit, so a value edit reddens here and
 * needs a new activation gate rather than a re-pin.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const limits = require('../../../src/gateway/slash_limits.js');
const XChainVM = require('../../../src/index.js');

describe('gateway: contract.slash amount-precision ceilings', function () {

    it('builds byte-identical amount forms from the two ceilings', function () {
        assert.strictEqual(limits.SLASH_AMOUNT_LEGACY_DECIMALS, 8);
        assert.strictEqual(limits.MAX_SLASH_AMOUNT_DECIMALS, 18);
        assert.strictEqual(limits.SLASH_AMOUNT_LEGACY_RE.source, '^[0-9]+(\\.[0-9]{1,8})?$');
        assert.strictEqual(limits.SLASH_AMOUNT_WIDE_RE.source, '^[0-9]+(\\.[0-9]{1,18})?$');
        assert.strictEqual(limits.SLASH_AMOUNT_LEGACY_RE.flags, '');
        assert.strictEqual(limits.SLASH_AMOUNT_WIDE_RE.flags, '');
    });

    it('exports the same ceiling from index.js that the gateway regex is built from', function () {
        assert.strictEqual(XChainVM.MAX_SLASH_AMOUNT_DECIMALS, limits.MAX_SLASH_AMOUNT_DECIMALS);
    });
});
