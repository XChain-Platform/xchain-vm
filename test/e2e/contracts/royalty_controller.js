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

// Enforced-royalty controller for a controller-bound token.
//
// A token issued with CONTROLLER = <this contract's action_index> (and
// ideally LOCK_CONTROLLER = 1) routes every guarded native action through
// the `guard` method below before it settles. This contract taxes SALES
// only — it takes a fixed basis-points cut out of the sale proceeds and
// forwards the cut to the creator and the remainder to the seller — while
// letting plain transfers (gifts, wallet moves) and listings through free.
//
// Royalty math is floor(price * bps / 10000), computed with mod-remainder
// arithmetic so cut + remainder == price EXACTLY (no rounding dust). That
// exactness is what lets the indexer's post-guard conservation check pass:
// the controller must forward 100% of the routed proceeds, keeping nothing.
//
// See xchain-documentation/protocol/Controller_Bound_Tokens.md for the
// guard ABI, proceeds-routing model, and gas/reentrancy rules.
module.exports = {
    // initialize(creator, bps) — call once via EXECUTE right after deploy,
    // before binding the token. `bps` is the royalty in basis points
    // (e.g. '1000' = 10%, '250' = 2.5%), capped at 100% (10000).
    initialize: function(xchain) {
        xchain.require(!xchain.state.has('creator'), 'already initialized');

        var creator = xchain.getInputParam(0);
        var bps     = xchain.getInputParam(1);
        xchain.require(creator && creator.length > 0, 'creator required');
        xchain.require(bps && xchain.math.gte(bps, '0'), 'bps required');
        xchain.require(xchain.math.lte(bps, '10000'), 'bps exceeds 100%');

        xchain.state.set('creator', creator);
        xchain.state.set('bps', bps);
        xchain.state.set('paidTotal', '0'); // lifetime royalties forwarded (bookkeeping)
        xchain.log('royalty controller initialized', creator, bps);
    },

    // guard(action_type, from, to, tick, amount, price, proceeds_tick)
    //   Return normally  => ALLOW (state + emissions commit atomically).
    //   revert(reason)    => DENY  (action invalid, everything rolled back).
    guard: function(xchain) {
        var actionType   = xchain.getInputParam(0);
        var from         = xchain.getInputParam(1); // seller (gives up the token)
        var price        = xchain.getInputParam(5); // proceeds amount ('' if not a sale)
        var proceedsTick = xchain.getInputParam(6); // proceeds tick ('' if not a sale)

        // Sales are the only taxed events. Everything else — plain SEND
        // (gift / wallet move) and the create-side listing gates
        // (ORDER_CREATE / SWAP_CREATE / DISPENSER_CREATE) — passes free.
        var isSale = actionType === 'ORDER_MATCH'
                  || actionType === 'SWAP_MATCH'
                  || actionType === 'DISPENSE';
        if (!isSale) {
            return; // ALLOW, untaxed
        }

        // Native-coin proceeds (off-ledger COINPay) carry no on-ledger
        // amount to route — royalty is out of scope there in v1. Allow the
        // sale; a stricter policy could revert to forbid native-priced sales.
        if (!proceedsTick || !price || xchain.math.lte(price, '0')) {
            return; // ALLOW, nothing to route
        }

        // Proceeds routing: the indexer has already credited `price` of
        // `proceedsTick` to THIS controller's derived address. Sanity-check
        // that it landed, then forward 100% of it back out (cut + remainder).
        var self = xchain.getContractAddress();
        var held = xchain.getBalance(self, proceedsTick) || '0';
        xchain.require(xchain.math.gte(held, price), 'proceeds not routed');

        var bps = xchain.state.get('bps') || '0';

        // cut = floor(price * bps / 10000), exactly, via mod-remainder:
        //   scaled - (scaled mod 10000) is divisible by 10000, so the
        //   divide terminates with no rounding. remainder = price - cut.
        var scaled    = xchain.math.multiply(price, bps);
        var dust      = xchain.math.mod(scaled, '10000');
        var cut       = xchain.math.divide(xchain.math.subtract(scaled, dust), '10000');
        var toSeller  = xchain.math.subtract(price, cut);

        // Forward the creator's cut (skip a zero cut — dust-sized trades
        // floor to no royalty, and emitting a zero quantity is invalid).
        if (xchain.math.gt(cut, '0')) {
            xchain.emit.send({
                destination: xchain.state.get('creator'),
                tick:        proceedsTick,
                quantity:    cut
            });
            xchain.state.set('paidTotal',
                xchain.math.add(xchain.state.get('paidTotal') || '0', cut));
        }

        // Forward the remainder to the seller. cut + toSeller == price, so
        // the controller's net proceeds balance returns to where it began —
        // the host-side conservation check passes.
        if (xchain.math.gt(toSeller, '0')) {
            xchain.emit.send({
                destination: from,
                tick:        proceedsTick,
                quantity:    toSeller
            });
        }

        xchain.log('royalty', cut, 'to creator,', toSeller, 'to seller', from);
        // return => ALLOW
    },

    // getStats() — read-only view of the configured royalty + lifetime total.
    getStats: function(xchain) {
        return {
            creator:   xchain.state.get('creator'),
            bps:       xchain.state.get('bps'),
            paidTotal: xchain.state.get('paidTotal')
        };
    }
};
