// @ts-nocheck
//
'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Determinism fixtures for the contract-targeted staking, external
// attestation, and cross-contract/cross-chain call VM host methods:
//
//   xchain.contract.getStake / getTotalStaked / getStakers   (VM_STATE_READ)
//   xchain.contract.slash                                     (VM_EMISSION)
//   xchain.attestation.request                                (VM_ATTEST_REQUEST + VM_EMISSION)
//   xchain.attestation.getResponse                            (VM_STATE_READ)
//   xchain.emit.execute                                       (VM_EMISSION + gasLimit reservation)
//   xchain.emit.crossExecute                                  (VM_EMISSION + VM_XCALL_REQUEST
//                                                              + gasLimit + VM_XCALL_CALLBACK)
//
// Shared by BOTH determinism suites so each contract runs with byte-identical
// code AND identical injected accessor data:
//   - determinism.test.js          proves same-process run-twice equality
//   - determinism-baseline.test.js pins a committed SHA-256 digest
// A digest pinned in the baseline therefore means exactly the same thing the
// run-twice suite asserts. Keeping the inputs in one place is what makes that
// equivalence hold. Duplicating the code/accessors across both files would let
// them silently drift.
//
// The accessor objects below are pure, deterministic stand-ins for the indexer's
// real providers (xchain-indexer/src/db.js getContractStakeData() and the
// attestation-response store). They return the same shapes the production
// accessors return, so a change in gas charging, response serialisation, or
// __gas injection around these call sites shifts the digest and fails CI
// instead of surfacing only as an on-chain block-hash divergence.

// Two fixed, lowercase 64-hex pubkeys (contract.getStake lowercases its input,
// so the staker keys are stored lowercase to match).
const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

// Deterministic contract-stake accessor. Mirrors the { getStake, getTotalStaked,
// getStakers } shape returned by the indexer's getContractStakeData(). Amounts
// are pre-summed constants so the fixture carries no platform-dependent math.
function makeContractStakeData() {
    const stakers = {
        TOKENX: [
            { pubkey: PK_A, amount: '1500.00000000' },
            { pubkey: PK_B, amount: '500.00000000' }
        ]
    };
    return {
        getStake: (pubkey, token) => {
            const list = stakers[token] || [];
            const hit = list.find(s => s.pubkey === String(pubkey || '').toLowerCase());
            return hit ? hit.amount : '0';
        },
        // Pre-summed total for TOKENX (1500 + 500); '0' for any other token.
        getTotalStaked: (token) => (token === 'TOKENX' ? '2000.00000000' : '0'),
        // Already sorted by amount DESC, capped well under the 1000 cap.
        getStakers: (token) => (stakers[token] || []).map(s => ({ pubkey: s.pubkey, amount: s.amount }))
    };
}

// Deterministic attestation-response accessor. Returns a fixed, fully-serialised
// response for one known request_id and null otherwise. The shape is
// { status, payload, providerId, blockIndex, validatorCount } matching what the host stores.
function makeAttestationData() {
    const stored = {
        status:         'ok',
        payload:        '{"score":7}',
        providerId:     'http_get',
        blockIndex:     200,
        validatorCount: 1
    };
    return {
        getResponse: (id) => (id === 'abc123' ? stored : null)
    };
}

// Cross-contract call fixture builder. One fixture per allowed depth: the host
// threads opts.callDepth, so a contract running at callDepth N queues a call
// that will run at depth N+1. Depths 1–4 succeed (maxCallDepth default 4);
// callDepth 4 must produce the deterministic depth-gate throw BEFORE any gas
// is reserved. Each digest pins gasUsed (VM_EMISSION + the 5000 gasLimit
// reservation, charged atomically against `ceiling - used`) and the queued
// EXECUTE emission, so an order-of-operations or remaining-gas-check
// regression in gateway-emit.js fails CI instead of forking gasUsed.
// getCallDepth() is folded into the return value so the depth threading
// itself is part of the pinned output.
function makeEmitExecuteFixture(callDepth) {
    const targetDepth = callDepth + 1;
    const gated = targetDepth > 4;
    return {
        name: gated
            ? `inline:emit-execute-depth${targetDepth}-throw`
            : `inline:emit-execute-depth${targetDepth}`,
        code: `module.exports = function(xchain) {
            xchain.emit.execute({
                contractIndex: 200,
                method: 'onCall',
                params: ['p1', 'p2'],
                gasLimit: 5000
            });
            return { depth: xchain.getCallDepth(), queued: true };
        };`,
        extra: { state: {}, callDepth },
        ...(gated ? { expectSuccess: false } : {})
    };
}

// Each fixture: { name, code, extra, expectSuccess? }.
//   name: stable key in DETERMINISM_BASELINE.json; DO NOT rename without regen.
//   code: inline contract source (single exported function, dispatched as the
//         default method exactly like the existing inline:* fixtures).
//   extra: opts merged on top of the suite's baseOpts (accessor injection plus a
//          clean empty state so nothing unrelated bleeds into the digest).
//   expectSuccess: false for fixtures whose pinned output is a deterministic
//          failure (e.g. the depth-gate throw); absent means success expected.
//
// attestation.request derives request_id from
// sha256(TX_HASH:ROOT_ACTION_INDEX:EMITTER_PATH:CONTRACT_INDEX:EMITTER_POSITION),
// so txHash + contractIndex are pinned to fixed values to keep the digest stable.
// providerDeadlines is intentionally omitted so only the platform-wide [1,100]
// deadline check applies (the per-provider window lives in the indexer).
const CONTRACT_HOST_FIXTURES = [
    {
        name: 'inline:contract-stake-reads',
        code: `module.exports = function(xchain) {
            return {
                stake:   xchain.contract.getStake('${PK_A}', 'TOKENX'),
                total:   xchain.contract.getTotalStaked('TOKENX'),
                stakers: xchain.contract.getStakers('TOKENX')
            };
        };`,
        extra: { state: {}, contractStakeData: makeContractStakeData() }
    },
    {
        name: 'inline:contract-slash',
        code: `module.exports = function(xchain) {
            xchain.contract.slash('${PK_A}', 'TOKENX', '100.00000000');
            return 'slashed';
        };`,
        extra: { state: {}, contractIndex: 100 }
    },
    {
        name: 'inline:attestation-request',
        code: `module.exports = function(xchain) {
            return xchain.attestation.request(
                'http_get',
                'https://example.com/data',
                'onResult',
                ['ctx'],
                { redundancy: 1, deadlineBlocks: 10 }
            );
        };`,
        extra: { state: {}, txHash: 'deadbeefcafe', contractIndex: 100 }
    },
    {
        // Paid-attestation (E1) variant. Same call as inline:attestation-request
        // but with non-empty feeTick/feeAmount in options, so the ATTEST emission
        // carries the fee pass-through fields. Pins the non-zero-fee code path
        // separately from the zero-fee one above (the VM only shape-checks the
        // fee fields; the indexer enforces XCHAIN-only tick / amount / payer
        // balance), so a regression in fee normalisation or emission shaping
        // shifts THIS digest while leaving the zero-fee digest untouched.
        name: 'inline:attestation-request-paid',
        code: `module.exports = function(xchain) {
            return xchain.attestation.request(
                'http_get',
                'https://example.com/data',
                'onResult',
                ['ctx'],
                { redundancy: 1, deadlineBlocks: 10, feeTick: 'XCHAIN', feeAmount: '5.00000000' }
            );
        };`,
        extra: { state: {}, txHash: 'deadbeefcafe', contractIndex: 100 }
    },
    {
        name: 'inline:attestation-getresponse',
        code: `module.exports = function(xchain) {
            return xchain.attestation.getResponse('abc123');
        };`,
        extra: { state: {}, attestationData: makeAttestationData() }
    },
    // emit.execute at depths 1–4 (callDepth 0–3) plus the depth-5 gate throw
    // (callDepth 4).
    makeEmitExecuteFixture(0),
    makeEmitExecuteFixture(1),
    makeEmitExecuteFixture(2),
    makeEmitExecuteFixture(3),
    makeEmitExecuteFixture(4),
    {
        // Cross-CHAIN call. Pins the 4-bucket charge (VM_EMISSION +
        // VM_XCALL_REQUEST + gasLimit + VM_XCALL_CALLBACK; the suite's
        // GAS_SCHEDULE must carry the two XCALL keys at production values) and
        // the deterministic callId, which is returned so the digest covers the
        // sha256(network:chain:txHash:contractIndex:emissionIndex:targetChain)
        // preimage, including the emissionIndex derived from
        // emissionCollector.actions.length at emit time. action_index is
        // intentionally NOT part of the preimage because it depends on injection timing.
        // Every preimage input is pinned via `extra`; sourceChain comes from baseOpts'
        // contractAddress ('C:BTC:100'), so LTC is a valid distinct target.
        name: 'inline:emit-crossexecute',
        code: `module.exports = function(xchain) {
            var callId = xchain.emit.crossExecute({
                targetChain: 'LTC',
                contractIndex: 300,
                method: 'onRemote',
                params: ['x1', 'x2'],
                gasLimit: 5000,
                callbackMethod: 'onResult',
                callbackParams: ['ctx'],
                deadlineBlocks: 100
            });
            return { callId: callId, hops: xchain.getCrossHops() };
        };`,
        extra: {
            state: {},
            network: 'mainnet',
            txHash: 'deadbeefcafe',
            actionIndex: 3,
            contractIndex: 100,
            crossHops: 0
        }
    }
];

module.exports = { CONTRACT_HOST_FIXTURES, makeContractStakeData, makeAttestationData };
