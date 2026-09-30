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
 * XChain VM: Emit API
 *
 * Each emit method validates basic parameter shape, charges gas,
 * and queues the action. Full validation happens in the indexer.
 *
 * The same-chain emits and the shared parameter checks live in
 * gateway_emit/; this file keeps the cross-chain call, the id preimage
 * builders and their golden vectors.
 ********************************************************************/
// @ts-nocheck

const { validateRequired } = require('./gateway_emit/param_validation.js');
const { buildExecuteEmit, buildTokenEmits, buildAccountEmits, buildGovernanceEmits } = require('./gateway_emit/same_chain.js');
const crypto = require('crypto');

// Canonical form of the per-root discriminator that enters the ATTEST request_id
// and XCALL call_id preimages (the value the host threads as rootActionIndex).
//
// Historically the value is always the root action's on-chain output index
// TX_VOUT, and the VM folded it through Number() so a numeric string and a number
// hash alike. A BATCH breaks the assumption TX_VOUT was carrying: every one of a
// BATCH's subcommands is a separate root action under ONE TX_VOUT, so two EXECUTE
// subcommands on the same contract derived the SAME request_id and the second
// request was dropped. The host therefore sends a COMPOSITE
// "<TX_VOUT>.<subcommand position>" for a root that is a BATCH subcommand, gated
// on BATCH_SUBCOMMAND_ROOT_DISCRIMINATOR (xchain-indexer/src/protocol_changes.js).
//
// Number() must not touch the composite form: Number('3.10') === Number('3.1'),
// which would re-collide exactly the roots the discriminator separates. Every
// non-composite value keeps its historical Number() coercion, so every id derived
// before the flag day stays byte-identical. '.' appears in no other preimage
// field and the field separator is ':', so the composite is one unambiguous token.
// MUST byte-match the indexer's re-derivation, which stringifies the same value
// (attest/index.js / xcall/index.js ROOT_ACTION_INDEX).
const ROOT_DISCRIMINATOR_COMPOSITE_RE = /^[0-9]+\.[0-9]+$/;
function normalizeRootDiscriminator(value) {
    if (value === undefined || value === null) return '';
    const text = String(value);
    if (ROOT_DISCRIMINATOR_COMPOSITE_RE.test(text)) return text;
    return Number(value);
}

// Assemble the ATTEST request_id and XCALL call_id preimages. The one VM-side
// statement of the per-field rules: both derivation sites (gateway.js
// attestation.request, crossExecute below) pass RAW host values and hash what
// comes back, so neither restates a formula.
//
// Two fields are folded and the folds are consensus-load-bearing. rootActionIndex
// goes through normalizeRootDiscriminator, never a bare Number(), or a BATCH
// subcommand's composite '<TX_VOUT>.<position>' collapses ('3.10' -> 3.1) and
// re-collides the roots it separates; contractIndex keeps its historical Number()
// coercion. The indexer re-derives with a bare String() on every field
// (attest/index.js / xcall/index.js), so the two sides agree over the input domain producers
// emit and not outside it; that edge is measured case by case in
// test/determinism/crossrepo-request-call-id-bytematch.test.js.
function buildRequestIdPreimage(fields) {
    const txHash          = fields.txHash || '';
    const rootActionIndex = fields.rootActionIndex != null ? normalizeRootDiscriminator(fields.rootActionIndex) : '';
    const callPath        = typeof fields.callPath === 'string' ? fields.callPath : '';
    const contractIndex   = fields.contractIndex != null ? Number(fields.contractIndex) : '';
    return String(txHash) + ':' + String(rootActionIndex) + ':' + callPath + ':' +
           String(contractIndex) + ':' + fields.emissionIndex;
}

function buildCallIdPreimage(fields) {
    const network         = fields.network || '';
    const txHash          = fields.txHash || '';
    const rootActionIndex = fields.rootActionIndex != null ? normalizeRootDiscriminator(fields.rootActionIndex) : '';
    const contractIndex   = fields.contractIndex != null ? Number(fields.contractIndex) : '';
    const callPath        = typeof fields.callPath === 'string' ? fields.callPath : '';
    return String(network) + ':' + fields.sourceChain + ':' +
           String(txHash) + ':' + String(rootActionIndex) + ':' +
           String(contractIndex) + ':' + callPath + ':' +
           fields.emissionIndex + ':' + fields.targetChain;
}

// Cross-CHAIN call (XCALL) protocol constants. Vendored single source of truth:
// ./protocol/constants.js (byte-identical to xchain-documentation/protocol/
// constants.js); mirrored in src/index.js exports and re-validated host-side by
// the indexer. Deriving from the vendored module makes a bare-literal drift
// impossible by construction.
const PROTO = require('./protocol/constants.js');
const XCALL_MIN_GAS             = PROTO.XCALL_MIN_GAS;
const XCALL_MAX_GAS             = PROTO.XCALL_MAX_GAS;
const XCALL_MAX_HOPS            = PROTO.XCALL_MAX_HOPS;
const XCALL_MIN_DEADLINE_BLOCKS = PROTO.XCALL_MIN_DEADLINE_BLOCKS;
const XCALL_MAX_DEADLINE_BLOCKS = PROTO.XCALL_MAX_DEADLINE_BLOCKS;
const XCALL_DEFAULT_DEADLINE    = 400;   // caller default only; not a protocol bound (absent from canonical)

// VM_XCALL_REQUEST / VM_XCALL_CALLBACK are charged directly from the schedule
// (like VM_EMISSION). Both are CANONICAL_GAS_KEYS, so GasTracker construction
// already rejects a schedule that omits them. No silent fallback default that
// could diverge gasUsed (and fee) across the fleet on config drift.

const ALLOWED_TARGET_CHAINS = ['BTC', 'LTC', 'DOGE'];

function buildEmitAPI(gasTracker, emissionCollector, gasSchedule, callContext) {
    const charge = () => gasTracker.charge(gasSchedule.VM_EMISSION);
    // Cross-contract call context, injected by the host (index.js) from
    // opts.callDepth + limits. Absent (legacy callers / tests building the
    // emit API directly) -> depth 0 with the protocol defaults.
    const ctx = callContext || {};
    const callDepth    = Number.isInteger(ctx.callDepth)    ? ctx.callDepth    : 0;
    const maxCallDepth = Number.isInteger(ctx.maxCallDepth) ? ctx.maxCallDepth : 4;
    const minCallGas   = Number.isInteger(ctx.minCallGas)   ? ctx.minCallGas   : 5000;
    const crossHops    = Number.isInteger(ctx.crossHops)    ? ctx.crossHops    : 0;
    // ctx.callPath (the deterministic '>'-joined call-path, root = '') and
    // ctx.rootActionIndex (the per-root discriminator, pinned at the root) enter
    // the call_id preimage. buildCallIdPreimage reads and normalizes them straight
    // off ctx, so they are deliberately not re-derived into locals here.
    // Controller-guard mode disables the asynchronous cross-chain call path: a
    // guard must return its allow/deny decision synchronously, before the guarded
    // native action settles (the XCALL result would land blocks later).
    const isGuard      = Boolean(ctx.isGuard);

    return {
        ...buildExecuteEmit(gasTracker, emissionCollector, gasSchedule, callDepth, maxCallDepth, minCallGas),
        ...buildCrossExecuteEmit(gasTracker, emissionCollector, gasSchedule, ctx, crossHops, isGuard),
        ...buildTokenEmits(charge, emissionCollector),
        ...buildAccountEmits(charge, emissionCollector),
        ...buildGovernanceEmits(charge, emissionCollector)
    };
}

// Cross-CHAIN contract call (deferred, slow). Queues an XCALL request
// that the validator federation relays to the target chain after this
// chain's confirmation depth (design async; typically minutes to tens of
// minutes). The outcome ALWAYS arrives via callbackMethod(call_id,
// target_chain, status, return_payload, ...callbackParams); if no
// result lands before deadlineBlocks, a deterministic 'expired'
// callback fires instead. The target method must be in the target
// contract's exported `crossCallable` allowlist. No value moves.
//
// Gas: pre-pays VM_EMISSION + the request bucket + the remote ceiling
// (gasLimit) + the fixed callback bucket, all charged NOW out of this
// run's budget. The remote side runs fee-less against gasLimit; there
// is NO refund of unused remote gas in v1 (over-provisioning is the
// caller's cost).
//
// Returns the deterministic call_id.
function buildCrossExecuteEmit(gasTracker, emissionCollector, gasSchedule, ctx, crossHops, isGuard) {
    return {
        crossExecute: (params) => {
            if (isGuard)
                throw new Error('emit.crossExecute: not available to a controller guard');
            validateRequired(params, ['targetChain', 'contractIndex', 'method', 'gasLimit', 'callbackMethod']);

            // Hop gate first (deterministic throw before any gas moves): hops
            // are HOST-threaded context. User-originated runs are 0; a
            // cross-chain-injected execution or result callback carries its
            // call's count. This prevents two contracts from ping-ponging forever.
            if (crossHops + 1 > XCALL_MAX_HOPS)
                throw new Error('emit.crossExecute: max cross-chain hops ' + XCALL_MAX_HOPS + ' reached');

            const targetChain = params.targetChain;
            if (typeof targetChain !== 'string' || ALLOWED_TARGET_CHAINS.indexOf(targetChain) === -1)
                throw new Error('emit.crossExecute: targetChain must be one of ' + ALLOWED_TARGET_CHAINS.join('/'));
            // Source chain comes from the contract's own derived address (C:<CHAIN>:<idx>).
            const sourceChain = String(ctx.contractAddress || '').split(':')[1] || '';
            if (targetChain === sourceChain)
                throw new Error('emit.crossExecute: targetChain must differ from this chain (use emit.execute for same-chain calls)');

            const { idx, method, args } = validateXcallCallee(params);
            const { callbackMethod, cbParams } = validateXcallCallback(params);
            const { deadlineBlocks, gasLimit, totalCharge } = validateXcallBudget(params, gasTracker, gasSchedule);
            const callId = deriveXcallCallId(ctx, sourceChain, targetChain, emissionCollector);

            gasTracker.charge(totalCharge);
            emissionCollector.add('XCALL', {
                callId:         callId,
                targetChain:    targetChain,
                contractIndex:  idx,
                method:         method,
                params:         args,
                gasLimit:       gasLimit,
                callbackMethod: callbackMethod,
                callbackParams: cbParams.map(String),
                deadlineBlocks: deadlineBlocks
                // crossHops is HOST-derived in the indexer (processEmission);
                // deliberately NOT taken from the VM.
            });
            return callId;
        }
    };
}

// Callee checks for emit.crossExecute, in the order they throw: the target
// contract index, the method name, then the delimiter-free string params.
function validateXcallCallee(params) {
    const idx = Number(params.contractIndex);
    if (!Number.isInteger(idx) || idx <= 0 || idx > Number.MAX_SAFE_INTEGER)
        throw new Error('emit.crossExecute: contractIndex must be a positive integer');

    const method = params.method;
    if (typeof method !== 'string' || method.length === 0 || Buffer.byteLength(method, 'utf8') > 64)
        throw new Error('emit.crossExecute: method must be a non-empty string (max 64 bytes)');
    if (method.indexOf('|') !== -1)
        throw new Error('emit.crossExecute: method must not contain "|"');

    const args = params.params === undefined || params.params === null ? [] : params.params;
    if (!Array.isArray(args) || args.length > 32)
        throw new Error('emit.crossExecute: params must be an array of <= 32 strings');
    for (const a of args) {
        if (typeof a !== 'string' || Buffer.byteLength(a, 'utf8') > 1024)
            throw new Error('emit.crossExecute: params entries must be strings (max 1024 bytes)');
        if (a.indexOf('|') !== -1)
            throw new Error('emit.crossExecute: params entries must not contain "|"');
    }
    return { idx, method, args };
}

// Callback checks for emit.crossExecute: a bounded, delimiter-free method
// name and a parameter array whose stringified JSON fits in 1024 bytes.
function validateXcallCallback(params) {
    const callbackMethod = params.callbackMethod;
    if (typeof callbackMethod !== 'string' || callbackMethod.length === 0 || Buffer.byteLength(callbackMethod, 'utf8') > 64)
        throw new Error('emit.crossExecute: callbackMethod must be a non-empty string (max 64 bytes)');
    if (callbackMethod.indexOf('|') !== -1)
        throw new Error('emit.crossExecute: callbackMethod must not contain "|"');

    const cbParams = params.callbackParams === undefined || params.callbackParams === null ? [] : params.callbackParams;
    if (!Array.isArray(cbParams))
        throw new Error('emit.crossExecute: callbackParams must be an array');
    let cbJson;
    try { cbJson = JSON.stringify(cbParams.map(String)); }
    catch (e) { throw new Error('emit.crossExecute: callbackParams must be JSON-serializable'); }
    if (Buffer.byteLength(cbJson, 'utf8') > 1024)
        throw new Error('emit.crossExecute: callbackParams JSON exceeds 1024 bytes');
    return { callbackMethod, cbParams };
}

// Deadline window, remote gas ceiling and the total pre-paid charge for
// emit.crossExecute, which must fit in THIS run's remaining gas.
function validateXcallBudget(params, gasTracker, gasSchedule) {
    const deadlineBlocks = params.deadlineBlocks !== undefined ? Number(params.deadlineBlocks) : XCALL_DEFAULT_DEADLINE;
    if (!Number.isInteger(deadlineBlocks) || deadlineBlocks < XCALL_MIN_DEADLINE_BLOCKS || deadlineBlocks > XCALL_MAX_DEADLINE_BLOCKS)
        throw new Error('emit.crossExecute: deadlineBlocks must be an integer in [' +
            XCALL_MIN_DEADLINE_BLOCKS + ', ' + XCALL_MAX_DEADLINE_BLOCKS + ']');

    // gasLimit bounds: the remote run is fee-less on its chain, so the
    // cap is much tighter than the same-chain 1M ceiling.
    const gasLimit = params.gasLimit;
    if (!Number.isInteger(gasLimit) || gasLimit < XCALL_MIN_GAS || gasLimit > XCALL_MAX_GAS)
        throw new Error('emit.crossExecute: gasLimit must be an integer in [' + XCALL_MIN_GAS + ', ' + XCALL_MAX_GAS + ']');

    const totalCharge = gasSchedule.VM_EMISSION + gasSchedule.VM_XCALL_REQUEST + gasLimit + gasSchedule.VM_XCALL_CALLBACK;
    const remaining = gasTracker.ceiling - gasTracker.used;
    if (totalCharge > remaining)
        throw new Error('emit.crossExecute: total charge ' + totalCharge + ' exceeds remaining gas ' + remaining);
    return { deadlineBlocks, gasLimit, totalCharge };
}

// The deterministic call_id for one emit.crossExecute, read at the current
// emission index.
function deriveXcallCallId(ctx, sourceChain, targetChain, emissionCollector) {
    // Deterministic call_id, derived BEFORE pushing the emission so it
    // reflects the current emission index. Network + source chain are
    // bound into the preimage (unlike the attestation request_id)
    // because BTC-family chains share tx-hash space; a call must never
    // collide or replay across chains/networks. The target chain is
    // bound so the same logical call to two chains never collides.
    // MUST byte-match the indexer's re-derivation in
    // xchain-indexer/src/actions/xcall/index.js (parseRequest, EMITTER_PATH).
    // The emitting EXECUTE's action_index is deliberately NOT in the preimage:
    // it shifts with the indexer's synthetic-action injection timing, so it is
    // non-deterministic across nodes / reorgs. The call-path replaces it as the
    // disambiguator. (tx_hash, contract_index, emission_index) alone are NOT
    // unique because emission_index is per-execution; two nested runs of the
    // SAME contract each emitting their first call would collide. The call-path
    // uniquely names this execution in the call tree and is content-derived.
    // Assembled by the canonical builder above (raw ctx values in, folds
    // applied there once) so the formula is not restated at this site.
    const emissionIndex = emissionCollector.actions ? emissionCollector.actions.length : 0;
    const preimage = buildCallIdPreimage({
        network:         ctx.network,
        sourceChain:     sourceChain,
        txHash:          ctx.txHash,
        rootActionIndex: ctx.rootActionIndex,
        contractIndex:   ctx.contractIndex,
        callPath:        ctx.callPath,
        emissionIndex:   emissionIndex,
        targetChain:     targetChain
    });
    const callId = crypto.createHash('sha256').update(preimage).digest('hex');
    return callId;
}

// Checked-in golden vectors for the ATTEST request_id and XCALL call_id preimage
// formulas. These are a fixed (input tuple -> expected hex) pair that the VM
// cross-repo byte-match test AND the indexer attest.test.js/xcall.test.js can
// both assert against independently. If either side's preimage drifts, the
// affected suite fails even when the two inline lambda copies happen to match each
// other (i.e. both were edited in lockstep, masking the fork).
//
// The tuples are deliberately minimal: enough fields to exercise every component
// of each preimage, with values that are easy to verify by hand.
//
// ATTEST request_id preimage: TX_HASH:ROOT_ACTION_INDEX:EMITTER_PATH:CONTRACT_INDEX:EMITTER_POSITION
// XCALL call_id preimage:     NETWORK:COIN:TX_HASH:ROOT_ACTION_INDEX:CONTRACT_INDEX:EMITTER_PATH:EMITTER_POSITION:TARGET_CHAIN
//
// Do NOT change these values without regenerating and committing both the VM
// crossrepo test assertions and the corresponding indexer test assertions.
const GOLDEN_VECTORS = {
    requestId: {
        input: {
            txHash:          'abc123',
            rootActionIndex: 100,
            emitterPath:     '',
            contractIndex:   7,
            emitterPosition: 0
        },
        // sha256('abc123:100::7:0')
        expected: 'b770a548716259f767c3eb6e9e1e5eb0e3878c9ec3d6bbd68a7e1ab8221fffb7'
    },
    callId: {
        input: {
            network:         'regtest',
            coin:            'BTC',
            txHash:          'f'.repeat(64),
            rootActionIndex: 100,
            contractIndex:   42,
            emitterPath:     '',
            emitterPosition: 0,
            targetChain:     'DOGE'
        },
        // sha256('regtest:BTC:<64 f chars>:100:42::0:DOGE')
        expected: 'bca0e6ab4e60a2ec7ea96ab4935c0a4db936be5ce9d8cab0d899b4144a7ae480'
    }
};

// XCALL_MAX_HOPS is exported as the single in-VM source of truth for the hop
// cap: this module is the emit-time ENFORCER (crossExecute's hop gate above),
// and src/index.js re-exports this value for the cross-service parity suite,
// so the enforced and the parity-tested value can never diverge.
// The preimage builders are exported for gateway.js and for the cross-repo
// guards, which drive the REAL derivation rather than a lookalike lambda.
module.exports = {
    buildEmitAPI, GOLDEN_VECTORS, XCALL_MAX_HOPS, normalizeRootDiscriminator,
    buildRequestIdPreimage, buildCallIdPreimage
};
