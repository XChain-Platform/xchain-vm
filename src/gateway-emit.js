/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain VM — Emit API
 *
 * Each emit method validates basic parameter shape, charges gas,
 * and queues the action. Full validation happens in the indexer.
 ********************************************************************/
// @ts-nocheck

// 


function validateRequired(params, fields) {
    if (typeof params !== 'object' || params === null)
        throw new Error('emit params must be an object');
    for (const field of fields) {
        if (params[field] === undefined || params[field] === null)
            throw new Error('emit: missing required field: ' + field);
    }
}

// Type validation for common emission fields.
// Catches misuse early before reaching the indexer.
function validateTypes(params, typeSpec) {
    for (const [field, type] of Object.entries(typeSpec)) {
        if (params[field] !== undefined && params[field] !== null) {
            if (typeof params[field] !== type)
                throw new Error('emit: field ' + field + ' must be a ' + type + ', got ' + typeof params[field]);
        }
    }
}

const crypto = require('crypto');

// Cross-CHAIN call (XCALL) protocol constants — canonical:
// xchain-documentation/protocol/constants.js; mirrored in src/index.js exports
// and re-validated host-side by the indexer.
const XCALL_MIN_GAS             = 5000;
const XCALL_MAX_GAS             = 200000;
const XCALL_MAX_HOPS            = 2;
const XCALL_MIN_DEADLINE_BLOCKS = 10;
const XCALL_MAX_DEADLINE_BLOCKS = 4000;
const XCALL_DEFAULT_DEADLINE    = 400;

// Fixed gas buckets pre-paid at emit time, resolvable from the schedule with
// identical defaults (the per-chain configs in the indexer carry the same
// values; the default is belt-and-suspenders so a schedule gap can never make
// two operators charge differently).
function xcallRequestGas(gasSchedule){
    return Number.isInteger(gasSchedule.VM_XCALL_REQUEST) ? gasSchedule.VM_XCALL_REQUEST : 2000;
}
function xcallCallbackGas(gasSchedule){
    return Number.isInteger(gasSchedule.VM_XCALL_CALLBACK) ? gasSchedule.VM_XCALL_CALLBACK : 20000;
}

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
    // Controller-guard mode disables the asynchronous cross-chain call path: a
    // guard must return its allow/deny decision synchronously, before the guarded
    // native action settles (the XCALL result would land blocks later).
    const isGuard      = Boolean(ctx.isGuard);

    return {
        // Cross-contract call (deferred). Queues an EXECUTE on another (or the
        // same) contract, run by the indexer AFTER this method completes, inside
        // the same atomicity scope. No return value — a callee that must respond
        // calls back via its own emit.execute (callback pattern).
        //
        // Gas: charges VM_EMISSION + gasLimit NOW, out of THIS run's budget —
        // the reservation is what the callee runs against (its gas ceiling), so
        // total work per top-level EXECUTE can never exceed the caller's own
        // ceiling regardless of call-tree shape. Unused reservation is refunded
        // at the top-level fee settlement (indexer-side).
        execute: (params) => {
            validateRequired(params, ['contractIndex', 'method', 'gasLimit']);
            // Depth gate first: a contract at the max depth gets a deterministic
            // throw before any gas is reserved.
            if (callDepth + 1 > maxCallDepth)
                throw new Error('emit.execute: max call depth ' + maxCallDepth + ' reached');

            // contractIndex: positive integer (number or numeric string)
            const idx = Number(params.contractIndex);
            if (!Number.isInteger(idx) || idx <= 0 || idx > Number.MAX_SAFE_INTEGER)
                throw new Error('emit.execute: contractIndex must be a positive integer');

            // method: non-empty string, <= 64 bytes, no wire delimiter
            const method = params.method;
            if (typeof method !== 'string' || method.length === 0 || Buffer.byteLength(method, 'utf8') > 64)
                throw new Error('emit.execute: method must be a non-empty string (max 64 bytes)');
            if (method.indexOf('|') !== -1)
                throw new Error('emit.execute: method must not contain "|"');

            // params: optional array of delimiter-free strings. The indexer joins
            // them with "|" into METHOD_PARAMS (the positional EXECUTE format), so
            // an embedded "|" would shift the callee's argument arity.
            const args = params.params === undefined || params.params === null ? [] : params.params;
            if (!Array.isArray(args))
                throw new Error('emit.execute: params must be an array of strings');
            if (args.length > 32)
                throw new Error('emit.execute: params exceeds 32 entries');
            for (const a of args) {
                if (typeof a !== 'string')
                    throw new Error('emit.execute: params entries must be strings');
                if (Buffer.byteLength(a, 'utf8') > 1024)
                    throw new Error('emit.execute: params entry exceeds 1024 bytes');
                if (a.indexOf('|') !== -1)
                    throw new Error('emit.execute: params entries must not contain "|"');
            }

            // gasLimit: integer reservation, bounded below by the protocol minimum
            // (bounds tree fan-out) and above by THIS run's remaining gas, so the
            // explicit error fires before the reservation could trip the ceiling.
            const gasLimit = params.gasLimit;
            if (!Number.isInteger(gasLimit) || gasLimit < minCallGas)
                throw new Error('emit.execute: gasLimit must be an integer >= ' + minCallGas);
            const remaining = gasTracker.ceiling - gasTracker.used;
            if (gasLimit + gasSchedule.VM_EMISSION > remaining)
                throw new Error('emit.execute: gasLimit ' + gasLimit + ' exceeds remaining gas ' + remaining);

            // Reserve: emission cost + the callee's entire budget, charged here.
            gasTracker.charge(gasSchedule.VM_EMISSION + gasLimit);
            emissionCollector.add('EXECUTE', {
                contractIndex: idx,
                method:        method,
                params:        args,
                gasLimit:      gasLimit
            });
        },

        // Cross-CHAIN contract call (deferred, slow). Queues an XCALL request
        // that the validator federation relays to the target chain after this
        // chain's confirmation depth (minutes-to-tens-of-minutes — design
        // async). The outcome ALWAYS arrives via callbackMethod(call_id,
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
        crossExecute: (params) => {
            if (isGuard)
                throw new Error('emit.crossExecute: not available to a controller guard');
            validateRequired(params, ['targetChain', 'contractIndex', 'method', 'gasLimit', 'callbackMethod']);

            // Hop gate first (deterministic throw before any gas moves): hops
            // are HOST-threaded context — user-originated runs are 0, a
            // cross-chain-injected execution or result callback carries its
            // call's count — so two contracts cannot ping-pong forever.
            if (crossHops + 1 > XCALL_MAX_HOPS)
                throw new Error('emit.crossExecute: max cross-chain hops ' + XCALL_MAX_HOPS + ' reached');

            const targetChain = params.targetChain;
            if (typeof targetChain !== 'string' || ALLOWED_TARGET_CHAINS.indexOf(targetChain) === -1)
                throw new Error('emit.crossExecute: targetChain must be one of ' + ALLOWED_TARGET_CHAINS.join('/'));
            // Source chain comes from the contract's own derived address (C:<CHAIN>:<idx>).
            const sourceChain = String(ctx.contractAddress || '').split(':')[1] || '';
            if (targetChain === sourceChain)
                throw new Error('emit.crossExecute: targetChain must differ from this chain (use emit.execute for same-chain calls)');

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

            const deadlineBlocks = params.deadlineBlocks !== undefined ? Number(params.deadlineBlocks) : XCALL_DEFAULT_DEADLINE;
            if (!Number.isInteger(deadlineBlocks) || deadlineBlocks < XCALL_MIN_DEADLINE_BLOCKS || deadlineBlocks > XCALL_MAX_DEADLINE_BLOCKS)
                throw new Error('emit.crossExecute: deadlineBlocks must be an integer in [' +
                    XCALL_MIN_DEADLINE_BLOCKS + ', ' + XCALL_MAX_DEADLINE_BLOCKS + ']');

            // gasLimit bounds: the remote run is fee-less on its chain, so the
            // cap is much tighter than the same-chain 1M ceiling.
            const gasLimit = params.gasLimit;
            if (!Number.isInteger(gasLimit) || gasLimit < XCALL_MIN_GAS || gasLimit > XCALL_MAX_GAS)
                throw new Error('emit.crossExecute: gasLimit must be an integer in [' + XCALL_MIN_GAS + ', ' + XCALL_MAX_GAS + ']');

            const totalCharge = gasSchedule.VM_EMISSION + xcallRequestGas(gasSchedule) + gasLimit + xcallCallbackGas(gasSchedule);
            const remaining = gasTracker.ceiling - gasTracker.used;
            if (totalCharge > remaining)
                throw new Error('emit.crossExecute: total charge ' + totalCharge + ' exceeds remaining gas ' + remaining);

            // Deterministic call_id, derived BEFORE pushing the emission so it
            // reflects the current emission index. Network + source chain are
            // bound into the preimage (unlike the attestation request_id)
            // because BTC-family chains share tx-hash space — a call must never
            // collide or replay across chains/networks. The target chain is
            // bound so the same logical call to two chains never collides.
            // MUST byte-match the indexer's re-derivation in
            // xchain-indexer/src/actions/xcall.js (_parseRequest).
            const txHash        = ctx.txHash || '';
            const actionIndex   = ctx.actionIndex != null ? Number(ctx.actionIndex) : '';
            const contractIndex = ctx.contractIndex != null ? Number(ctx.contractIndex) : '';
            const emissionIndex = emissionCollector.actions ? emissionCollector.actions.length : 0;
            const preimage = String(ctx.network || '') + ':' + sourceChain + ':' +
                             String(txHash) + ':' + String(actionIndex) + ':' +
                             String(contractIndex) + ':' + emissionIndex + ':' + targetChain;
            const callId = crypto.createHash('sha256').update(preimage).digest('hex');

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
                // crossHops is HOST-derived in the indexer (processEmission) —
                // deliberately NOT taken from the VM.
            });
            return callId;
        },
        send: (params) => {
            charge();
            validateRequired(params, ['destination', 'tick', 'quantity']);
            validateTypes(params, { destination: 'string', tick: 'string', quantity: 'string' });
            emissionCollector.add('SEND', params);
        },
        destroy: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('DESTROY', params);
        },
        issue: (params) => {
            charge();
            validateRequired(params, ['tick']);
            validateTypes(params, { tick: 'string' });
            emissionCollector.add('ISSUE', params);
        },
        mint: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('MINT', params);
        },
        order: (params) => {
            charge();
            validateRequired(params, ['giveAmount', 'getAmount']);
            validateTypes(params, { giveAmount: 'string', getAmount: 'string' });
            emissionCollector.add('ORDER', params);
        },
        dispenser: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('DISPENSER', params);
        },
        dividend: (params) => {
            charge();
            validateRequired(params, ['tick', 'dividendTick', 'quantity']);
            validateTypes(params, { tick: 'string', dividendTick: 'string', quantity: 'string' });
            emissionCollector.add('DIVIDEND', params);
        },
        airdrop: (params) => {
            charge();
            validateRequired(params, ['tick', 'quantity', 'listActionIndex']);
            validateTypes(params, { tick: 'string', quantity: 'string' });
            emissionCollector.add('AIRDROP', params);
        },
        callback: (params) => {
            charge();
            validateRequired(params, ['tick']);
            validateTypes(params, { tick: 'string' });
            emissionCollector.add('CALLBACK', params);
        },
        file: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('FILE', params);
        },
        list: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('LIST', params);
        },
        coinpay: (params) => {
            charge();
            validateRequired(params, ['orderMatchActionIndex']);
            emissionCollector.add('COINPAY', params);
        },
        sweep: (params) => {
            charge();
            validateRequired(params, ['destination']);
            validateTypes(params, { destination: 'string' });
            emissionCollector.add('SWEEP', params);
        },
        link: (params) => {
            charge();
            validateRequired(params, ['coin1', 'coin1ActionIndex', 'coin2', 'coin2ActionIndex']);
            validateTypes(params, { coin1: 'string', coin2: 'string' });
            emissionCollector.add('LINK', params);
        },
        broadcast: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            emissionCollector.add('BROADCAST', params);
        },
        message: (params) => {
            charge();
            validateRequired(params, ['destination']);
            validateTypes(params, { destination: 'string' });
            emissionCollector.add('MESSAGE', params);
        }
    };
}

module.exports = { buildEmitAPI };
