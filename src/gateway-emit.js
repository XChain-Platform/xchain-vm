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

function buildEmitAPI(gasTracker, emissionCollector, gasSchedule, callContext) {
    const charge = () => gasTracker.charge(gasSchedule.VM_EMISSION);
    // Cross-contract call context, injected by the host (index.js) from
    // opts.callDepth + limits. Absent (legacy callers / tests building the
    // emit API directly) -> depth 0 with the protocol defaults.
    const ctx = callContext || {};
    const callDepth    = Number.isInteger(ctx.callDepth)    ? ctx.callDepth    : 0;
    const maxCallDepth = Number.isInteger(ctx.maxCallDepth) ? ctx.maxCallDepth : 4;
    const minCallGas   = Number.isInteger(ctx.minCallGas)   ? ctx.minCallGas   : 5000;

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
