// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Counter contract: increment/decrement with state persistence
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('counter', '0');
        xchain.state.set('owner', xchain.getSourceAddress());
    },
    increment: function(xchain) {
        var count = xchain.state.get('counter') || '0';
        count = xchain.math.add(count, '1');
        xchain.state.set('counter', count);
        return count;
    },
    decrement: function(xchain) {
        var count = xchain.state.get('counter') || '0';
        xchain.require(xchain.math.gt(count, '0'), 'counter is zero');
        count = xchain.math.subtract(count, '1');
        xchain.state.set('counter', count);
        return count;
    },
    getCount: function(xchain) {
        return xchain.state.get('counter');
    }
};
