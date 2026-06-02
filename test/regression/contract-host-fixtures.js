'use strict';

// ---------------------------------------------------------------------------
// Determinism fixtures for the contract-targeted staking + external
// attestation VM host methods:
//
//   xchain.contract.getStake / getTotalStaked / getStakers   (VM_STATE_READ)
//   xchain.contract.slash                                     (VM_EMISSION)
//   xchain.attestation.request                                (VM_ATTEST_REQUEST + VM_EMISSION)
//   xchain.attestation.getResponse                            (VM_STATE_READ)
//
// Shared by BOTH determinism suites so each contract runs with byte-identical
// code AND identical injected accessor data:
//   - determinism.test.js          proves same-process run-twice equality
//   - determinism-baseline.test.js pins a committed SHA-256 digest
// A digest pinned in the baseline therefore means exactly the same thing the
// run-twice suite asserts. Keeping the inputs in one place is what makes that
// equivalence hold — duplicating the code/accessors across both files would let
// them silently drift.
//
// The accessor objects below are pure, deterministic stand-ins for the indexer's
// real providers (xchain-indexer/src/db.js getContractStakeData() and the
// attestation-response store). They return the same shapes the production
// accessors return, so a change in gas charging, response serialisation, or
// __gas injection around these call sites shifts the digest and fails CI —
// instead of surfacing only as an on-chain block-hash divergence.
// ---------------------------------------------------------------------------

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
// response for one known request_id and null otherwise — the same { status,
// payload, providerId, blockIndex, validatorCount } shape the host stores.
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

// Each fixture: { name, code, extra }.
//   name  — stable key in DETERMINISM_BASELINE.json; DO NOT rename without regen.
//   code  — inline contract source (single exported function, dispatched as the
//           default method exactly like the existing inline:* fixtures).
//   extra — opts merged on top of the suite's baseOpts (accessor injection plus a
//           clean empty state so nothing unrelated bleeds into the digest).
//
// attestation.request derives request_id from sha256(txHash:contractIndex:emissionIndex),
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
        name: 'inline:attestation-getresponse',
        code: `module.exports = function(xchain) {
            return xchain.attestation.getResponse('abc123');
        };`,
        extra: { state: {}, attestationData: makeAttestationData() }
    }
];

module.exports = { CONTRACT_HOST_FIXTURES, makeContractStakeData, makeAttestationData };
