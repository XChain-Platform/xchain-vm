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
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');
const { ContractRevertError } = require('./errors.js');
const { buildEmitAPI } = require('./gateway-emit.js');
const { buildMathAPI } = require('./math.js');

// contract.slash amount forms, pre- and post-activation.
// The legacy form caps fractional digits at 8; the widened form allows the token
// ceiling MAX_TOKEN_DECIMALS (18, xchain-indexer/src/config.js), the precision
// STAKE v3 already admits and slashContractStake already computes at. Which form
// applies is decided by readOnlyData.slashAmountPrecisionOn (host-set, see
// isSlashAmountPrecisionActive in index.js) because ACCEPTING a call that used to
// throw changes replay for historical blocks exactly as rejecting one does.
const SLASH_AMOUNT_LEGACY_RE = /^[0-9]+(\.[0-9]{1,8})?$/;
const SLASH_AMOUNT_WIDE_RE   = /^[0-9]+(\.[0-9]{1,18})?$/;

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
        // Read-only context (0 gas)
        getBlockHeight:     () => readOnlyData.blockContext.height,
        getBlockTimestamp:   () => readOnlyData.blockContext.timestamp,
        getBlockHash:        () => readOnlyData.blockContext.hash,
        getSourceAddress:    () => readOnlyData.caller,
        getContractAddress:  () => readOnlyData.contractAddress,
        getInputParams:      () => [...readOnlyData.params],
        getInputParam:       (i) => readOnlyData.params[i] !== undefined ? readOnlyData.params[i] : null,
        getInputParamCount:  () => readOnlyData.params.length,
        // Cross-contract call depth: 0 for a user-submitted EXECUTE, parent+1 for
        // a run reached via emit.execute. Lets library contracts guard themselves
        // before emit.execute throws at the max-depth gate.
        getCallDepth:        () => Number.isInteger(readOnlyData.callDepth) ? readOnlyData.callDepth : 0,
        getCrossHops:        () => Number.isInteger(readOnlyData.crossHops) ? readOnlyData.crossHops : 0,

        // Read-only ledger queries (100 gas each)
        getBalance: (address, tick) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.balances) return null;
            return readOnlyData.balances[address]?.[tick] || null;
        },
        getTokenInfo: (tick) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.tokenInfo) return null;
            return readOnlyData.tokenInfo[tick] || null;
        },
        // Frozen result of a finalized VOTE governance poll (the governance hook:
        // a contract branches on a poll outcome - release a treasury, flip a
        // parameter). Returns null for an unknown or not-yet-finalized poll, so a
        // contract can tell "not decided" from a real result. Deterministic: the
        // result is immutable post-finalization and identical on every node.
        getPollResult: (pollIndex) => {
            gasTracker.charge(gasSchedule.VM_STATE_READ);
            if (!readOnlyData.pollData) return null;
            return readOnlyData.pollData.getPollResult(pollIndex);
        },

        // Contract state (metered)
        state: {
            get: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                return stateManager.get(key);
            },
            has: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                return stateManager.has(key);
            },
            set: (key, value) => {
                gasTracker.charge(gasSchedule.VM_STATE_WRITE);
                stateManager.set(key, value);
            },
            delete: (key) => {
                gasTracker.charge(gasSchedule.VM_STATE_DELETE);
                return stateManager.delete(key);
            }
        },

        // Oracle. getPrice/getPriceAtRound are metered (VM_ORACLE_READ, 100 gas
        // each). getSnapshotAge is INTENTIONALLY gas-free, like the zero-gas
        // context accessors: its value is deterministic across all nodes, each
        // call site is already bounded by control-flow gas, and the gas-free
        // behavior is pinned by test/unit/gateway.test.js (charging it would be
        // a consensus gas-schedule change).
        oracle: {
            getPrice: (coinPair) => {
                gasTracker.charge(gasSchedule.VM_ORACLE_READ);
                if (!readOnlyData.oracleData) return null;
                return readOnlyData.oracleData.getPrice(coinPair);
            },
            getPriceAtRound: (coinPair, roundNumber) => {
                gasTracker.charge(gasSchedule.VM_ORACLE_READ);
                if (!readOnlyData.oracleData) return null;
                return readOnlyData.oracleData.getPriceAtRound(coinPair, roundNumber);
            },
            // Gas-free by design (see the oracle group comment above).
            getSnapshotAge: () => {
                if (!readOnlyData.oracleData) return Number.MAX_SAFE_INTEGER;
                return readOnlyData.oracleData.getSnapshotAge();
            }
        },

        // Cross-chain (metered)
        crossChain: {
            getAttestation: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.getAttestation(chain, actionIndex) || null;
            },
            isSettled: (chain, actionIndex) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.isSettled(chain, actionIndex) || false;
            },
            // Outcome of a cross-chain call THIS chain originated:
            // { status, payload } once terminal (visible the block after it
            // resolved), null while in flight. The callback (emit.crossExecute's
            // callbackMethod) is the primary delivery; this read backs
            // idempotency checks and late consumers.
            getCallResult: (callId) => {
                gasTracker.charge(gasSchedule.VM_CROSSCHAIN_READ);
                return readOnlyData.crossChainData?.getCallResult(callId) || null;
            }
        },

        // External attestation (Phase 1, metered)
        // Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
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
                // Platform-wide hard cap. Sized to the largest registered
                // provider's max_request_bytes (llm = 8192). Per-provider
                // ceiling is enforced by the indexer; this cap is a safety
                // net so a contract can't emit a huge payload before
                // governance has registered a provider that allows it.
                if (Buffer.byteLength(requestPayload, 'utf8') > 8192)
                    throw new Error('attestation.request: requestPayload exceeds 8192 bytes');
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
                // xchain-indexer/src/actions/attest.js (_parseRequest, EMITTER_PATH).
                let txHash          = readOnlyData.txHash || '';
                // Per-root discriminator (deterministic root on-chain action_index). Without it,
                // two forest roots under one tx_hash (e.g. a top-level EXECUTE and a controlled-
                // token guard, both seeding callPath '') derive the SAME request_id. Pinned at the
                // root, threaded unchanged. MUST byte-match the indexer (attest.js ROOT_ACTION_INDEX).
                let rootActionIndex = readOnlyData.rootActionIndex != null ? Number(readOnlyData.rootActionIndex) : '';
                let callPath        = typeof readOnlyData.callPath === 'string' ? readOnlyData.callPath : '';
                let contractIndex   = readOnlyData.contractIndex != null ? Number(readOnlyData.contractIndex) : '';
                let emissionIndex   = emissionCollector.actions ? emissionCollector.actions.length : 0;
                let preimage = String(txHash) + ':' + String(rootActionIndex) + ':' + callPath + ':' + String(contractIndex) + ':' + emissionIndex;
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
            },
            // Read a previously-stored attestation response for any request from this contract.
            // Returns null if the request hasn't been fulfilled yet (or doesn't exist).
            getResponse: (requestId) => {
                gasTracker.charge(gasSchedule.VM_STATE_READ);
                if (typeof requestId !== 'string') return null;
                if (!readOnlyData.attestationData) return null;
                return readOnlyData.attestationData.getResponse(requestId);
            }
        },

        // Contract-targeted staking: readable + slashable from inside the contract being staked TO.
        // The contractStakeData accessor is pre-loaded by execute.js for ONLY the currently-executing
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
            // time, see deploy.js). Reaches both active stakes AND cooldown-queued balances
            // per the plan; over-slash is silently capped at available balance.
            slash: (pubkey, token, amount) => {
                gasTracker.charge(gasSchedule.VM_EMISSION);
                if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))
                    throw new Error('contract.slash: pubkey must be a 64-hex string');
                if (typeof token !== 'string' || token.length === 0)
                    throw new Error('contract.slash: token must be a non-empty string');
                // Keep the wire delimiter out of the token field, matching
                // emit.execute / attestation.request. Inert against today's consumer
                // (SLASH is internal-only and the indexer's _processSlashEmission reads
                // {contractIndex, pubkey, token, amount} by NAMED field, never pipe-
                // splitting), so this is defense-in-depth for the day SLASH is joined
                // on-wire like EXECUTE's METHOD_PARAMS. Gated (host sets
                // readOnlyData.slashTokenDelimGuardOn) because rejecting a call that
                // used to emit successfully changes replay for historical blocks.
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
                let contractIndex = readOnlyData.contractIndex;
                emissionCollector.add('SLASH', {
                    contractIndex: contractIndex,
                    pubkey:        pubkey,
                    token:         token,
                    amount:        amount
                });
            }
        },

        // Action emission (metered, 500 gas each; emit.execute additionally
        // reserves the callee's gasLimit; emit.crossExecute pre-pays the
        // request + remote ceiling + callback, see gateway-emit.js)
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
