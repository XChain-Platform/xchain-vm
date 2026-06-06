// @ts-nocheck
// 
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Configurable gateway caller for chaos testing.
// params[0] = number of state writes (default 2)
// params[1] = number of oracle reads (default 3)
// Executes state writes first, then oracle reads in sequence.
module.exports = function(xchain) {
    var stateSets   = parseInt(xchain.getInputParam(0) || '2', 10);
    var oracleCalls = parseInt(xchain.getInputParam(1) || '3', 10);
    var results = [];

    for (var i = 0; i < stateSets; i++) {
        xchain.state.set('key_' + i, 'val_' + i);
    }

    for (var j = 0; j < oracleCalls; j++) {
        var price = xchain.oracle.getPrice('BTC/USD');
        results.push(String(price));
    }

    return { stateWrites: stateSets, oracleReads: oracleCalls, prices: results };
};
