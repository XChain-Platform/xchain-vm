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
 * XChain VM Gateway Builder
 *
 * Builds the xchain gateway object that contracts interact with.
 * Every state/ledger/emission method is gas-metered.
 *
 * This module returns a plain JS object on the host side.
 * The index.js module wraps each method as an ivm.Reference
 * before injecting into the isolate.
 *
 * The metered accessors and the contract-staking namespace are built in
 * gateway/ and spread in here, so the object keeps one member order.
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');
const { ContractRevertError } = require('./errors.js');
const { buildEmitAPI, buildRequestIdPreimage } = require('./gateway_emit.js');
const { buildMathAPI } = require('./math.js');
const { buildContextAPI, buildStateAPI, buildOracleAPI, buildCrossChainAPI } = require('./gateway/accessors.js');
const { buildContractStakeAPI } = require('./gateway/contract_stake.js');

/**
 * Build the gateway object for contract execution.
 * @param {GasTracker} gasTracker
 * @param {StateManager} stateManager
 * @param {EmissionCollector} emissionCollector
 * @param {object} readOnlyData - { caller, contractAddress, params, blockContext, balances, tokenInfo, oracleData, crossChainData, providerDeadlines }
 *   providerDeadlines: optional { [providerId]: maxDeadlineBlocks } map, injected
 *   by the host so attestation.request() enforces the per-provider window at call time.
 * @param {object} gasSchedule
 * @param {object} execContext - Shared execution context { reverted: false }
 * @returns {object} The xchain gateway object
 */
function buildGateway(gasTracker, stateManager, emissionCollector, readOnlyData, gasSchedule, execContext) {
    return {
        ...buildContextAPI(gasTracker, readOnlyData, gasSchedule),
        ...buildStateAPI(gasTracker, stateManager, gasSchedule),
        ...buildOracleAPI(gasTracker, readOnlyData, gasSchedule),
        ...buildCrossChainAPI(gasTracker, readOnlyData, gasSchedule),
        ...buildAttestationAPI(gasTracker, emissionCollector, readOnlyData, gasSchedule),
        ...buildContractStakeAPI(gasTracker, emissionCollector, readOnlyData, gasSchedule),

        // Action emission (metered, 500 gas each; emit.execute additionally
        // reserves the callee's gasLimit; emit.crossExecute pre-pays the
        // request + remote ceiling + callback, see gateway_emit.js)
        emit: buildEmitAPI(gasTracker, emissionCollector, gasSchedule, {
            callDepth:    readOnlyData.callDepth,
            maxCallDepth: readOnlyData.maxCallDepth,
            minCallGas:   readOnlyData.minCallGas,
            // Cross-chain call context: hop budget + the call_id derivation
            // inputs (network + source chain bound into the preimage so
            // BTC-family chains sharing tx-hash space can never collide).
            crossHops:       readOnlyData.crossHops,
            network:         readOnlyData.network,
            contractAddress: readOnlyData.contractAddress,
            txHash:          readOnlyData.txHash,
            actionIndex:     readOnlyData.actionIndex,
            rootActionIndex: readOnlyData.rootActionIndex,
            callPath:        readOnlyData.callPath,
            contractIndex:   readOnlyData.contractIndex,
            isGuard:         readOnlyData.isGuard
        }),

        // Deterministic math (wraps mathjs bignumber). F-MO: above the flag-day
        // (host sets readOnlyData.mathOutputMeterOn) an oversized result (e.g. a
        // tiny-input pow producing a multi-MB fixed-notation string host-side) is
        // charged gas by predicted length BEFORE mathjs.format() allocates, so it
        // trips the deterministic gas ceiling instead of the host allocator. Below
        // the gate the hook is null and behaviour is unchanged.
        math: buildMathAPI(
            readOnlyData.mathOutputMeterOn ? (units) => gasTracker.charge(units) : null
        ),

        ...buildControlFlowAPI(emissionCollector, execContext)
    };
}

// External attestation (Phase 1, metered)
// Spec: external attestation framework.
function buildAttestationAPI(gasTracker, emissionCollector, readOnlyData, gasSchedule) {
    return {
        attestation: {
            // Emit an attestation request. Returns a deterministic request_id derived
            // from sha256("<tx_hash>:<rootActionIndex>:<callPath>:<contractIndex>:<emissionIndex>") (colon-delimited). The contract
            // proceeds synchronously; the response arrives later via the callback method.
            request: (providerId, requestPayload, callbackMethod, callbackParams, options) => {
                // A controller guard runs synchronously inside a native action's
                // settlement and must return an allow/deny decision now; it cannot
                // wait blocks for an attestation response. Reject before charging.
                if (readOnlyData.isGuard)
                    throw new Error('attestation.request: not available to a controller guard');
                gasTracker.charge(gasSchedule.VM_ATTEST_REQUEST);
                gasTracker.charge(gasSchedule.VM_EMISSION);
                if (typeof providerId !== 'string' || providerId.length === 0 || Buffer.byteLength(providerId, 'utf8') > 32)
                    throw new Error('attestation.request: providerId must be a non-empty string (max 32 bytes)');
                if (typeof requestPayload !== 'string')
                    throw new Error('attestation.request: requestPayload must be a string');
                // Platform-wide hard cap, and a SAFETY NET only: it is sized to
                // the LARGEST registered provider's max_request_bytes (llm =
                // 8192), so it says nothing about the named provider's own
                // envelope. It does not cover a smaller provider, and today that
                // gap is live: http_get's max_request_bytes is 2048
                // (xchain-indexer providerRegistry.js), so a 2049..8192-byte
                // http_get payload passes every check here, is charged
                // VM_ATTEST_REQUEST gas, lands on-chain, and is rejected
                // host-side as 'invalid: REQUEST_PAYLOAD (exceeds provider max)'
                // - terminal at creation, invisible to the pending pool, so the
                // callback never fires. That is the same silent stranding the
                // injected providerDeadlines ceiling below exists to prevent for
                // deadlines. Closing it means injecting the per-provider
                // envelope the same way, which tightens a consensus-visible VM
                // outcome and so needs its own mirrored activation pair; it is
                // deliberately NOT done here, and this comment states the gap
                // rather than implying a coverage the cap does not have.
                // The redundancy and deadline literals below have the same
                // shape but no live gap: [1, 3, 5] equals both registered
                // providers' allowed_redundancy, and llm's 20-block window is
                // already enforced through the injected map.
                if (Buffer.byteLength(requestPayload, 'utf8') > 8192)
                    throw new Error('attestation.request: requestPayload exceeds 8192 bytes');
                let callbackParamsJson = validateAttestCallback(callbackMethod, callbackParams);
                let envelope = validateAttestOptions(options, providerId, readOnlyData);
                return queueAttestRequest(emissionCollector, readOnlyData, providerId, requestPayload,
                                          callbackMethod, callbackParamsJson, envelope);
            },
            // Read a previously-stored attestation response for any request from this contract.
            // Returns null if the request hasn't been fulfilled yet (or doesn't exist).
            getResponse: (requestId) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                if (typeof requestId !== 'string') return null;
                if (!readOnlyData.attestationData) return null;
                return readOnlyData.attestationData.getResponse(requestId);
            }
        }
    };
}

// Callback shape for attestation.request: a bounded method name and a
// JSON-serializable parameter array. Returns the JSON the emission carries.
function validateAttestCallback(callbackMethod, callbackParams) {
    if (typeof callbackMethod !== 'string' || callbackMethod.length === 0 || Buffer.byteLength(callbackMethod, 'utf8') > 64)
        throw new Error('attestation.request: callbackMethod must be a non-empty string (max 64 bytes)');
    if (!Array.isArray(callbackParams))
        throw new Error('attestation.request: callbackParams must be an array');
    let callbackParamsJson;
    try {
        callbackParamsJson = JSON.stringify(callbackParams);
    } catch (e) {
        throw new Error('attestation.request: callbackParams must be JSON-serializable');
    }
    if (Buffer.byteLength(callbackParamsJson, 'utf8') > 1024)
        throw new Error('attestation.request: callbackParams JSON exceeds 1024 bytes');
    return callbackParamsJson;
}

// Redundancy, deadline and the optional request fee for attestation.request,
// defaulted and range-checked in the order they throw, then held to the named
// provider's own deadline window. Returns the values the ATTEST emission carries.
function validateAttestOptions(options, providerId, readOnlyData) {
    let opts = options || {};
    let redundancy     = opts.redundancy     !== undefined ? Number(opts.redundancy)     : 1;
    let deadlineBlocks = opts.deadlineBlocks !== undefined ? Number(opts.deadlineBlocks) : 10;
    if ([1, 3, 5].indexOf(redundancy) === -1)
        throw new Error('attestation.request: redundancy must be 1, 3, or 5');
    if (!Number.isInteger(deadlineBlocks) || deadlineBlocks < 1 || deadlineBlocks > 100)
        throw new Error('attestation.request: deadlineBlocks must be an integer in [1, 100]');
    // Optional request fee (E1 paid attestations). Pass-through as
    // strings: the indexer enforces the consensus rules (XCHAIN-only
    // tick in v1, amount format, fee-payer balance), keeping the VM
    // agnostic to future tick loosening. Only basic shape checks here
    // so a contract bug throws at call time, not at indexing time.
    let feeTick   = opts.feeTick   !== undefined && opts.feeTick   !== null ? String(opts.feeTick).trim()   : '';
    let feeAmount = opts.feeAmount !== undefined && opts.feeAmount !== null ? String(opts.feeAmount).trim() : '';
    if (feeTick.indexOf('|') !== -1 || feeAmount.indexOf('|') !== -1)
        throw new Error('attestation.request: feeTick/feeAmount must not contain "|"');
    if (feeAmount !== '' && !/^\d+(\.\d{1,8})?$/.test(feeAmount))
        throw new Error('attestation.request: feeAmount must be a non-negative decimal with at most 8 decimal places');
    if (feeAmount !== '' && feeAmount !== '0' && feeTick === '')
        throw new Error('attestation.request: feeTick is required when feeAmount > 0');
    // Per-provider deadline ceiling, injected by the host at execution
    // setup (readOnlyData.providerDeadlines). The [1, 100] check above is
    // a platform-wide safety net; this enforces the named provider's
    // actual window so a contract gets a throw at call time instead of a
    // silent host-side DEADLINE rejection that strands the callback. The
    // map mirrors the host's provider registry; an unknown providerId is
    // left to the host's own known-provider check.
    let providerDeadlines = readOnlyData.providerDeadlines;
    if (providerDeadlines && Object.prototype.hasOwnProperty.call(providerDeadlines, providerId)) {
        let providerLimit = Number(providerDeadlines[providerId]);
        if (Number.isFinite(providerLimit) && deadlineBlocks > providerLimit)
            throw new Error('attestation.request: deadlineBlocks ' + deadlineBlocks +
                ' exceeds the "' + providerId + '" provider window of ' + providerLimit + ' blocks');
    }
    return { redundancy, deadlineBlocks, feeTick, feeAmount };
}

// Derive the request_id from the current emission index, then queue the
// ATTEST emission. Returns the request_id that attestation.request hands back.
function queueAttestRequest(emissionCollector, readOnlyData, providerId, requestPayload,
                            callbackMethod, callbackParamsJson, envelope) {
    let { redundancy, deadlineBlocks, feeTick, feeAmount } = envelope;
    // Derive deterministic request_id BEFORE pushing the emission so it
    // reflects the current emission index, not the post-push index.
    // The call-path is part of the preimage: without it, two nested
    // emit.execute runs of the SAME contract in the SAME tx (same tx_hash,
    // same contract_index, same emission index 0) would derive IDENTICAL
    // request_ids. The call-path (the '>'-joined per-execution emission
    // positions from the root on-chain action down to this execution;
    // root = '') uniquely names this execution in the call tree, so it
    // disambiguates every run, and unlike the old action_index it is
    // content-derived, so it stays byte-stable across nodes and reorgs
    // (action_index advanced with injection timing and forked the PBFT).
    // MUST byte-match the indexer's re-derivation in
    // xchain-indexer/src/actions/attest/index.js (parseRequest, EMITTER_PATH).
    // Assembled by buildRequestIdPreimage (gateway_emit.js), which owns the
    // per-field normalization for both preimage classes; raw readOnlyData
    // values go in.
    let emissionIndex = emissionCollector.actions ? emissionCollector.actions.length : 0;
    let preimage = buildRequestIdPreimage({
        txHash:          readOnlyData.txHash,
        rootActionIndex: readOnlyData.rootActionIndex,
        callPath:        readOnlyData.callPath,
        contractIndex:   readOnlyData.contractIndex,
        emissionIndex:   emissionIndex
    });
    let requestId = crypto.createHash('sha256').update(preimage).digest('hex');

    emissionCollector.add('ATTEST', {
        requestId:       requestId,
        providerId:      providerId,
        requestPayload:  requestPayload,
        callbackMethod:  callbackMethod,
        callbackParams:  callbackParamsJson,
        redundancy:      redundancy,
        deadlineBlocks:  deadlineBlocks,
        feeTick:         feeTick,
        feeAmount:       feeAmount
    });

    return requestId;
}

// Control flow and debug logging: the gas-free tail of the gateway object.
function buildControlFlowAPI(emissionCollector, execContext) {
    return {
        // Control flow (gas-free)
        // Store the revert reason in execContext so the error classifier can
        // verify it matches, prevents spoofing via caught reverts (RISK-04).
        revert: (reason) => {
            const r = reason || 'reverted';
            if (execContext) {
                execContext.reverted = true;
                execContext.revertReason = r;
            }
            throw new ContractRevertError(r);
        },
        require: (condition, reason) => {
            if (!condition) {
                const r = reason || 'requirement failed';
                if (execContext) {
                    execContext.reverted = true;
                    execContext.revertReason = r;
                }
                throw new ContractRevertError(r);
            }
        },

        // Debug logging (gas-free, capped at 100 entries)
        log: (...args) => {
            emissionCollector.addLog(args.map(String).join(' '));
        },
        isLogFull: () => emissionCollector.isLogFull(),
        getLogCount: () => emissionCollector.getLogCount()
    };
}

module.exports = { buildGateway };
