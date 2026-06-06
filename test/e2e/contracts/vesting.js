// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Vesting contract: time-locked token release
module.exports = {
    initialize: function(xchain) {
        xchain.state.set('beneficiary', xchain.getInputParam(0));
        xchain.state.set('token', xchain.getInputParam(1));
        xchain.state.set('totalAmount', xchain.getInputParam(2));
        xchain.state.set('startBlock', String(xchain.getBlockHeight()));
        xchain.state.set('cliffBlocks', xchain.getInputParam(3) || '100');
        xchain.state.set('vestingBlocks', xchain.getInputParam(4) || '1000');
        xchain.state.set('claimed', '0');
    },
    claim: function(xchain) {
        var caller = xchain.getSourceAddress();
        var beneficiary = xchain.state.get('beneficiary');
        xchain.require(caller === beneficiary, 'only beneficiary can claim');

        var currentBlock = xchain.getBlockHeight();
        var startBlock = parseInt(xchain.state.get('startBlock'));
        var cliffBlocks = parseInt(xchain.state.get('cliffBlocks'));
        var vestingBlocks = parseInt(xchain.state.get('vestingBlocks'));
        var totalAmount = xchain.state.get('totalAmount');
        var claimed = xchain.state.get('claimed');

        var elapsed = currentBlock - startBlock;
        xchain.require(elapsed >= cliffBlocks, 'cliff not reached');

        var vested;
        if (elapsed >= vestingBlocks) {
            vested = totalAmount;
        } else {
            vested = xchain.math.divide(
                xchain.math.multiply(totalAmount, String(elapsed)),
                String(vestingBlocks)
            );
        }

        var claimable = xchain.math.subtract(vested, claimed);
        xchain.require(xchain.math.gt(claimable, '0'), 'nothing to claim');

        xchain.state.set('claimed', xchain.math.add(claimed, claimable));

        xchain.emit.send({
            destination: beneficiary,
            tick: xchain.state.get('token'),
            quantity: claimable
        });

        return claimable;
    }
};
