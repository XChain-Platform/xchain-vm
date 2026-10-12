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
 * XChain VM: gateway options
 *
 * The per-execution option object handed to buildGateway.
 ********************************************************************/
// @ts-nocheck

// Canonical coercion for the per-root discriminator threaded into the request_id /
// call_id preimages (keeps a BATCH subcommand's composite form intact).
const { normalizeRootDiscriminator } = require('../../gateway-emit.js');
const {
    BINARY_ALLOC_GATE_BLOCK_TIME, isSlashTokenDelimGuardActive, isSlashAmountPrecisionActive,
} = require('./activations.js');

function resolveGateFlags(opts) {
    // F-MO gate: math output metering (charge for an oversized pow()/format
    // result host-side) moves gasUsed, so it activates fleet-wide only at/
    // after the same block-time flag-day as F3-binary/globals + F-NR. Below
    // it the gateway passes a null hook and math billing is unchanged.
    const mathBlockTime = opts.blockContext && Number(opts.blockContext.timestamp);
    const mathOutputMeterOn = Number.isFinite(mathBlockTime) &&
        mathBlockTime >= BINARY_ALLOC_GATE_BLOCK_TIME;
    // Reject a '|' in contract.slash's token field (see
    // isSlashTokenDelimGuardActive). Network-aware like the state-key gates.
    const slashTokenDelimGuardOn = isSlashTokenDelimGuardActive(opts.network, mathBlockTime);
    // Sibling gate: widen contract.slash's amount ceiling from 8 to 18 fractional
    // digits, matching the token precision the stake side already admits (see
    // isSlashAmountPrecisionActive). Network-aware, same flag-day.
    const slashAmountPrecisionOn = isSlashAmountPrecisionActive(opts.network, mathBlockTime);
    return { mathOutputMeterOn, slashTokenDelimGuardOn, slashAmountPrecisionOn };
}

function buildGatewayOptions(vm, opts, accessors) {
    return {
        ...resolveGateFlags(opts),
        caller:          opts.caller,
        contractAddress: opts.contractAddress,
        contractIndex:   opts.contractIndex != null ? Number(opts.contractIndex) : null,
        txHash:          opts.txHash || '',
        actionIndex:     opts.actionIndex != null ? Number(opts.actionIndex) : null,
        // Per-root discriminator: the root action's TX_VOUT (reorg-stable on-chain
        // output index), threaded unchanged through nested executions. Bound into the
        // request_id/call_id preimages alongside callPath so two VM-executing roots
        // under one tx_hash (each callPath '') cannot derive the same id. The field
        // is named rootActionIndex for historical reasons; the value is TX_VOUT, not
        // action_index. MUST byte-match the indexer's ROOT_ACTION_INDEX field, which
        // is also populated from TX_VOUT (execute.processEmission).
        // Normalized rather than Number()-folded: a BATCH's subcommands are each a
        // root action under ONE TX_VOUT, so the host sends the composite
        // "<TX_VOUT>.<subcommand position>" for those (flag-day gated indexer-side).
        // Number() would fold '3.10' and '3.1' together and re-collide them.
        rootActionIndex: opts.rootActionIndex != null ? normalizeRootDiscriminator(opts.rootActionIndex) : null,
        // Deterministic call-path: the '>'-joined per-execution emission
        // positions from the root on-chain action down to THIS execution
        // (root = ''). Replaces the injection-timing-dependent action_index
        // in the attestation request_id + cross-chain call_id preimages so
        // they stay byte-stable across nodes and reorgs. MUST byte-match the
        // indexer's EMITTER_PATH (xchain-indexer execute.processEmission).
        callPath:        typeof opts.callPath === 'string' ? opts.callPath : '',
        callDepth:       Number.isInteger(opts.callDepth) ? opts.callDepth : 0,
        maxCallDepth:    vm.limits.maxCallDepth,
        minCallGas:      vm.limits.minCallGas,
        // Cross-chain call context: network + hop budget feed the
        // emit.crossExecute call_id derivation and hop gate.
        network:         opts.network || '',
        crossHops:       Number.isInteger(opts.crossHops) ? opts.crossHops : 0,
        // Controller-guard mode: when the indexer runs a token's bound
        // contract `guard` method before a guarded native action settles,
        // the asynchronous frameworks (attestation, cross-chain calls) are
        // disabled: their results arrive blocks later, after the guarded
        // action has already committed or reverted. Enforced at emit time
        // in gateway.js (attestation.request) + gateway-emit.js (crossExecute).
        isGuard:         Boolean(opts.isGuard),
        params:          opts.params || [],
        blockContext:    opts.blockContext,
        balances:        opts.balances || {},
        tokenInfo:       opts.tokenInfo || {},
        oracleData:        accessors.oracleData,
        crossChainData:    accessors.crossChainData,
        attestationData:   accessors.attestationData,
        contractStakeData: accessors.contractStakeData,
        pollData:          accessors.pollData,
        providerDeadlines: opts.providerDeadlines || null
    };
}

module.exports = { buildGatewayOptions };
