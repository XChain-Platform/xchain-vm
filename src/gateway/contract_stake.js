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
 * XChain VM Gateway: contract-targeted staking
 *
 * The gateway's contract namespace: the stake reads and contract.slash,
 * all scoped to the executing contract. Returned as one gateway member
 * for buildGateway (../gateway.js) to spread into the gateway object.
 ********************************************************************/
// @ts-nocheck

// contract.slash amount forms, pre- and post-activation.
// The legacy form caps fractional digits at 8; the widened form allows the token
// ceiling MAX_TOKEN_DECIMALS (18, xchain-indexer/src/config.js), the precision
// STAKE v3 already admits and slashContractStake already computes at. Which form
// applies is decided by readOnlyData.slashAmountPrecisionOn (host-set, see
// isSlashAmountPrecisionActive in index.js) because ACCEPTING a call the legacy
// form rejects changes replay for historical blocks exactly as rejecting one does.
const SLASH_AMOUNT_LEGACY_RE = /^[0-9]+(\.[0-9]{1,8})?$/;
const SLASH_AMOUNT_WIDE_RE   = /^[0-9]+(\.[0-9]{1,18})?$/;

// Shape checks for one contract.slash call, in the order they throw: the
// pubkey, the token, the gated token-delimiter guard, then the amount form.
function validateSlashArgs(pubkey, token, amount, readOnlyData) {
    if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))
        throw new Error('contract.slash: pubkey must be a 64-hex string');
    if (typeof token !== 'string' || token.length === 0)
        throw new Error('contract.slash: token must be a non-empty string');
    // Keep the wire delimiter out of the token field, matching
    // emit.execute / attestation.request. Inert against today's consumer
    // (SLASH is internal-only and the indexer's processSlashEmission reads
    // {contractIndex, pubkey, token, amount} by NAMED field, never pipe-
    // splitting), so this is defense-in-depth for the day SLASH is joined
    // on-wire like EXECUTE's METHOD_PARAMS. Gated (host sets
    // readOnlyData.slashTokenDelimGuardOn) because rejecting a call that
    // emitted successfully before the gate changes replay for historical blocks.
    if (readOnlyData.slashTokenDelimGuardOn && token.indexOf('|') !== -1)
        throw new Error('contract.slash: token must not contain "|"');
    // The 8-dp ceiling contradicted the rest of the seam.
    // STAKE v3 admits a stake at the token's own DECIMALS (up to
    // MAX_TOKEN_DECIMALS 18) and slashContractStake does its arithmetic at that
    // same precision, so an exact partial slash of a 9-18-dp staked token could
    // never be emitted. Post-activation the ceiling is 18; pre-activation it
    // stays 8 so historical blocks replay byte-identically.
    const amountRe = readOnlyData.slashAmountPrecisionOn
        ? SLASH_AMOUNT_WIDE_RE : SLASH_AMOUNT_LEGACY_RE;
    if (typeof amount !== 'string' || !amountRe.test(amount))
        throw new Error('contract.slash: amount must be a positive decimal string');
}

// The contract namespace: stake reads (metered) and the metered slash emission.
function buildContractStakeAPI(gasTracker, emissionCollector, readOnlyData, gasSchedule) {
    return {
        // Contract-targeted staking: readable + slashable from inside the contract being staked TO.
        // The contractStakeData accessor is pre-loaded by execute/index.js for ONLY the currently-executing
        // contract's stakes; a contract cannot read/slash stakes targeting another contract.
        contract: {
            // Returns the SUM of active stake amounts for (pubkey, token) on THIS contract.
            // Returns '0' if no active stake (also during pre-activation grace).
            getStake: (pubkey, token) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                if (!readOnlyData.contractStakeData) return '0';
                if (typeof pubkey !== 'string' || typeof token !== 'string') return '0';
                return readOnlyData.contractStakeData.getStake(pubkey, token);
            },
            // Total active staked amount across all stakers for (token) on THIS contract.
            getTotalStaked: (token) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                if (!readOnlyData.contractStakeData) return '0';
                if (typeof token !== 'string') return '0';
                return readOnlyData.contractStakeData.getTotalStaked(token);
            },
            // Array of { pubkey, amount } stakers on THIS contract for (token).
            // Capped at 1000 entries, sorted by amount DESC. See plan §12.10.
            getStakers: (token) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                if (!readOnlyData.contractStakeData) return [];
                if (typeof token !== 'string') return [];
                return readOnlyData.contractStakeData.getStakers(token);
            },
            // Slash a staker on THIS contract. Authorization is implicit: contractStakeData
            // is scoped to the executing contract, and the emission carries contractIndex
            // (from readOnlyData) for defense-in-depth verification in the indexer handler.
            //
            // Slashed tokens are routed to the contract's slash_destination (locked at DEPLOY
            // time, see deploy/index.js). Reaches both active stakes AND cooldown-queued balances
            // per the plan; over-slash is silently capped at available balance.
            slash: (pubkey, token, amount) => {
                gasTracker.charge(gasSchedule.VM_EMISSION);
                validateSlashArgs(pubkey, token, amount, readOnlyData);
                let contractIndex = readOnlyData.contractIndex;
                emissionCollector.add('SLASH', {
                    contractIndex: contractIndex,
                    pubkey:        pubkey,
                    token:         token,
                    amount:        amount
                });
            }
        }
    };
}

module.exports = { buildContractStakeAPI };
