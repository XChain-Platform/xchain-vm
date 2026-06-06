// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Multi-method contract for method routing tests
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('value', '0');
    },
    setValue: function(xchain) {
        var val = xchain.getInputParam(0);
        xchain.require(val !== null, 'value required');
        xchain.state.set('value', val);
        return val;
    },
    getValue: function(xchain) {
        return xchain.state.get('value');
    },
    onlyOwner: function(xchain) {
        var owner = xchain.state.get('owner');
        xchain.require(xchain.getSourceAddress() === owner, 'not owner');
        return 'authorized';
    }
};
