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
 * XChain VM Emit API: same-chain emits
 *
 * The emit methods that queue an action on THIS chain: the deferred
 * cross-contract call (execute) and the protocol actions from send to
 * vote. Each builder returns the members it owns, in emit API order, for
 * buildEmitAPI (../gateway_emit.js) to spread into the one emit object.
 ********************************************************************/
// @ts-nocheck

const { validateRequired, validateTypes } = require('./param_validation.js');

// Cross-contract call (deferred). Queues an EXECUTE on another (or the
// same) contract, run by the indexer AFTER this method completes, inside
// the same atomicity scope. No return value; a callee that must respond
// calls back via its own emit.execute (callback pattern).
//
// Gas: charges VM_EMISSION + gasLimit NOW, out of THIS run's budget.
// The reservation is what the callee runs against (its gas ceiling), so
// total work per top-level EXECUTE can never exceed the caller's own
// ceiling regardless of call-tree shape. Unused reservation is refunded
// at the top-level fee settlement (indexer-side).
function buildExecuteEmit(gasTracker, emissionCollector, gasSchedule, callDepth, maxCallDepth, minCallGas) {
    return {
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
        }
    };
}

// Token and asset actions. Each charges VM_EMISSION first, then checks its
// required fields and their types, then queues the action; the indexer
// runs the full validation.
function buildTokenEmits(charge, emissionCollector) {
    return {
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
        }
    };
}

// Address-level actions: files, lists, coin payments, sweeps, links,
// broadcasts and messages. Same order as above: charge, check, queue.
function buildAccountEmits(charge, emissionCollector) {
    return {
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

// Governance: the one VOTE emit, which is the last member of the emit API.
function buildGovernanceEmits(charge, emissionCollector) {
    return {
        // Governance: a contract acts as its own poll actor. version 0 = create a
        // poll, version 1 = cast a ballot; v2 (finalize) and v3 (delegation) are not
        // contract-emittable (Section 16). The contract is the SOURCE, so hold-to-
        // create / hold-to-vote and any deposit/gas_escrow apply to its own balance.
        vote: (params) => {
            charge();
            if (typeof params !== 'object' || params === null) params = {};
            let version = Number(params.version);
            if (version === 1) {
                validateRequired(params, ['pollRef', 'ballot']);
                validateTypes(params, { ballot: 'string' });
            } else if (version === 0) {
                validateRequired(params, ['tick', 'endBlock', 'options']);
                validateTypes(params, { tick: 'string', options: 'string' });
            } else {
                throw new Error('emit.vote: version must be 0 (create) or 1 (ballot)');
            }
            emissionCollector.add('VOTE', params);
        }
    };
}

module.exports = { buildExecuteEmit, buildTokenEmits, buildAccountEmits, buildGovernanceEmits };
