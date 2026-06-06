// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Tests oracle gateway API
module.exports = {
    checkPrice: function(xchain) {
        var price = xchain.oracle.getPrice('BTC/USD');
        var age = xchain.oracle.getSnapshotAge();

        xchain.log('price:', JSON.stringify(price));
        xchain.log('age:', String(age));

        // In Track A (stub), price is null and age is MAX_SAFE_INTEGER
        if (price === null) {
            xchain.log('oracle not available');
            return 'no oracle';
        }

        xchain.require(age < 1000, 'oracle data too stale');
        return price;
    }
};
