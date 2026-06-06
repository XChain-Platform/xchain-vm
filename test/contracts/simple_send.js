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

// Simple contract: reads state, emits one SEND
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('token', 'TEST');
    },
    send: function(xchain) {
        var destination = xchain.getInputParam(0);
        var amount = xchain.getInputParam(1);
        var token = xchain.state.get('token');

        xchain.require(destination, 'destination required');
        xchain.require(amount, 'amount required');

        xchain.emit.send({
            destination: destination,
            tick: token,
            quantity: amount
        });

        xchain.log('sent', amount, token, 'to', destination);
        return 'sent';
    }
};
