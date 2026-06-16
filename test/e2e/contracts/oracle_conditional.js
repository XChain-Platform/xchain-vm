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

// Contract that branches based on oracle price data
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('token', xchain.getInputParam(0) || 'TEST');
        xchain.state.set('threshold', xchain.getInputParam(1) || '50000');
        xchain.state.set('pair', xchain.getInputParam(2) || 'BTC/USD');
    },
    checkAndSend: function(xchain) {
        var pair = xchain.state.get('pair');
        var threshold = xchain.state.get('threshold');
        var token = xchain.state.get('token');

        // Check oracle freshness
        var age = xchain.oracle.getSnapshotAge();
        xchain.require(age < 100, 'oracle data too stale: age=' + age);

        var price = xchain.oracle.getPrice(pair);
        xchain.require(price !== null, 'no oracle price for ' + pair);

        xchain.log('price:', price, 'threshold:', threshold);

        if (xchain.math.gte(price, threshold)) {
            xchain.emit.send({
                destination: xchain.getSourceAddress(),
                tick: token,
                quantity: '100'
            });
            return 'above_threshold';
        } else {
            return 'below_threshold';
        }
    }
};
