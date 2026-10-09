/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const StateManager = require('../../../src/state.js');
const EmissionCollector = require('../../../src/collector.js');
const { buildMathAPI } = require('../../../src/math.js');
const { resolveLimits } = require('../../../src/index/runtime/limits_defaults.js');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const DRIFT = 'contract-visible host error text drifted: a contract can catch this text and ' +
    'store it in hashed state, so a change to what a contract sees needs a CONSENSUS_VERSION ' +
    'bump and an activation gate; regolden here in the same change';

// Modules whose throws reach contract code: the bridge, the gas reference, and every
// host module they load. A module joining this closure fails the scan until it is pinned.
const ROOTS = ['gateway.js', 'state.js', 'collector.js', 'gas.js', 'index/gateway_injection.js',
    'index/runtime/gas_reference.js'];

function parse(rel) {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    return { src, ast: acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', allowHashBang: true }) };
}

function requireClosure() {
    const seen = new Set();
    const queue = ROOTS.slice();
    while (queue.length) {
        const rel = queue.pop();
        if (seen.has(rel)) continue;
        seen.add(rel);
        walk.simple(parse(rel).ast, {
            CallExpression(node) {
                const arg = node.arguments[0];
                if (node.callee.name !== 'require' || !arg || typeof arg.value !== 'string') return;
                if (!arg.value.startsWith('.')) return;
                let next = path.relative(SRC, path.resolve(path.dirname(path.join(SRC, rel)), arg.value));
                if (!next.endsWith('.js')) next += '.js';
                if (!next.startsWith('..') && fs.existsSync(path.join(SRC, next))) queue.push(next);
            }
        });
    }
    return [...seen].sort();
}

// The text each throw site builds: literals verbatim, other parts as {source}. A bare
// identifier shows its nearest declaration, so a default such as `reason || 'reverted'` is pinned.
function throwTexts(rel) {
    const { src, ast } = parse(rel);
    const text = (node) => src.slice(node.start, node.end).replace(/\s+/g, ' ');
    const declared = (name, ancestors) => {
        for (let i = ancestors.length - 1; i >= 0; i--) {
            for (const stmt of ancestors[i].body && Array.isArray(ancestors[i].body) ? ancestors[i].body : []) {
                if (stmt.type !== 'VariableDeclaration') continue;
                const hit = stmt.declarations.find((d) => d.id.type === 'Identifier' && d.id.name === name && d.init);
                if (hit) return name + ' = ' + text(hit.init);
            }
        }
        return name;
    };
    const template = (node, ancestors) => {
        if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
        if (node.type === 'BinaryExpression' && node.operator === '+')
            return template(node.left, ancestors) + template(node.right, ancestors);
        if (node.type === 'TemplateLiteral')
            return node.quasis.map((q, i) => q.value.cooked +
                (node.expressions[i] ? '{' + text(node.expressions[i]) + '}' : '')).join('');
        if (node.type === 'Identifier') return '{' + declared(node.name, ancestors) + '}';
        return '{' + text(node) + '}';
    };
    const out = [];
    walk.ancestor(ast, {
        ThrowStatement(node, ancestors) {
            const arg = node.argument;
            if ((arg.type === 'NewExpression' || arg.type === 'CallExpression') && arg.arguments.length)
                out.push(text(arg.callee) + ': ' + template(arg.arguments[0], ancestors));
            else out.push('throw ' + text(arg));
        }
    });
    return out.sort();
}

const GOLDEN_THROW_TEXTS = {
    'collector.js': [
        'Error: emission limit exceeded ({this.max})'
    ],
    'errors.js': [],
    'gas.js': [
        'Error: gas charge amount must be a non-negative finite number, got: {amount}',
        'Error: gas schedule is missing required key: {key}',
        'Error: gas schedule value for {key} must be a non-negative integer, got: {val = gasSchedule[key]}',
        'GasExhaustedError: {this.used}'
    ],
    'gateway-emit.js': [
        'Error: emit.crossExecute: callbackMethod must be a non-empty string (max 64 bytes)',
        'Error: emit.crossExecute: callbackMethod must not contain "|"',
        'Error: emit.crossExecute: callbackParams JSON exceeds 1024 bytes',
        'Error: emit.crossExecute: callbackParams must be JSON-serializable',
        'Error: emit.crossExecute: callbackParams must be an array',
        'Error: emit.crossExecute: contractIndex must be a positive integer',
        'Error: emit.crossExecute: deadlineBlocks must be an integer in [{XCALL_MIN_DEADLINE_BLOCKS = PROTO.XCALL_MIN_DEADLINE_BLOCKS}, {XCALL_MAX_DEADLINE_BLOCKS = PROTO.XCALL_MAX_DEADLINE_BLOCKS}]',
        'Error: emit.crossExecute: gasLimit must be an integer in [{XCALL_MIN_GAS = PROTO.XCALL_MIN_GAS}, {XCALL_MAX_GAS = PROTO.XCALL_MAX_GAS}]',
        'Error: emit.crossExecute: max cross-chain hops {XCALL_MAX_HOPS = PROTO.XCALL_MAX_HOPS} reached',
        'Error: emit.crossExecute: method must be a non-empty string (max 64 bytes)',
        'Error: emit.crossExecute: method must not contain "|"',
        'Error: emit.crossExecute: not available to a controller guard',
        'Error: emit.crossExecute: params entries must be strings (max 1024 bytes)',
        'Error: emit.crossExecute: params entries must not contain "|"',
        'Error: emit.crossExecute: params must be an array of <= 32 strings',
        "Error: emit.crossExecute: targetChain must be one of {ALLOWED_TARGET_CHAINS.join('/')}",
        'Error: emit.crossExecute: targetChain must differ from this chain (use emit.execute for same-chain calls)',
        'Error: emit.crossExecute: total charge {totalCharge = gasSchedule.VM_EMISSION + gasSchedule.VM_XCALL_REQUEST + gasLimit + gasSchedule.VM_XCALL_CALLBACK} exceeds remaining gas {remaining = gasTracker.ceiling - gasTracker.used}'
    ],
    'gateway.js': [
        "ContractRevertError: {r = reason || 'requirement failed'}",
        "ContractRevertError: {r = reason || 'reverted'}",
        'Error: attestation.request: callbackMethod must be a non-empty string (max 64 bytes)',
        'Error: attestation.request: callbackParams JSON exceeds 1024 bytes',
        'Error: attestation.request: callbackParams must be JSON-serializable',
        'Error: attestation.request: callbackParams must be an array',
        'Error: attestation.request: deadlineBlocks must be an integer in [1, 100]',
        'Error: attestation.request: deadlineBlocks {deadlineBlocks = opts.deadlineBlocks !== undefined ? Number(opts.deadlineBlocks) : 10} exceeds the "{providerId}" provider window of {providerLimit = Number(providerDeadlines[providerId])} blocks',
        'Error: attestation.request: feeAmount must be a non-negative decimal with at most 8 decimal places',
        'Error: attestation.request: feeTick is required when feeAmount > 0',
        'Error: attestation.request: feeTick/feeAmount must not contain "|"',
        'Error: attestation.request: not available to a controller guard',
        'Error: attestation.request: providerId must be a non-empty string (max 32 bytes)',
        'Error: attestation.request: redundancy must be 1, 3, or 5',
        'Error: attestation.request: requestPayload exceeds 8192 bytes',
        'Error: attestation.request: requestPayload must be a string'
    ],
    'gateway/accessors.js': [],
    'gateway/contract_stake.js': [
        'Error: contract.slash: amount must be a positive decimal string',
        'Error: contract.slash: pubkey must be a 64-hex string',
        'Error: contract.slash: token must be a non-empty string',
        'Error: contract.slash: token must not contain "|"'
    ],
    'gateway/slash_limits.js': [
        'Error: slash_limits: decimals must be a positive safe integer, got {decimals}'
    ],
    'gateway_emit/param_validation.js': [
        'Error: emit params must be an object',
        'Error: emit: field {field} must be a {type}, got {typeof params[field]}',
        'Error: emit: missing required field: {field}'
    ],
    'gateway_emit/same_chain.js': [
        'Error: emit.execute: contractIndex must be a positive integer',
        'Error: emit.execute: gasLimit must be an integer >= {minCallGas}',
        'Error: emit.execute: gasLimit {gasLimit = params.gasLimit} exceeds remaining gas {remaining = gasTracker.ceiling - gasTracker.used}',
        'Error: emit.execute: max call depth {maxCallDepth} reached',
        'Error: emit.execute: method must be a non-empty string (max 64 bytes)',
        'Error: emit.execute: method must not contain "|"',
        'Error: emit.execute: params entries must be strings',
        'Error: emit.execute: params entries must not contain "|"',
        'Error: emit.execute: params entry exceeds 1024 bytes',
        'Error: emit.execute: params exceeds 32 entries',
        'Error: emit.execute: params must be an array of strings',
        'Error: emit.vote: version must be 0 (create) or 1 (ballot)'
    ],
    'index/bigint_surface_strip_heights.js': [],
    'index/gateway_injection.js': [
        'Error: \x03GAS:{e.used}:{e.ceiling}',
        'Error: \x03REVERT:{e.message}',
        'throw e'
    ],
    'index/runtime/activation_heights.js': [],
    'index/runtime/activations.js': [],
    'index/runtime/gas_reference.js': [
        'Error: \x03GAS:{e.used}:{e.ceiling}',
        'throw e'
    ],
    'math.js': [
        'ContractRevertError: math error: {e.message}',
        'Error: Division by zero',
        'Error: math input exceeds maximum length ({MAX_MATH_INPUT_LENGTH = 256} chars)',
        'Error: result is not a finite number',
        'Error: result is not a real number',
        'throw e'
    ],
    'protocol/constants.js': [],
    'state.js': [
        'Error: contract exceeds max state keys ({this.limits.maxStateKeys})',
        'Error: state key contains a NUL (0x00) byte',
        'Error: state key contains a NUL (0x00) byte',
        'Error: state key exceeds max size ({maxKeySize = this.limits.maxStateKeySize || 1024} bytes)',
        'Error: state key exceeds max size ({maxKeySize = this.limits.maxStateKeySize || 1024} bytes)',
        'Error: state key must be a string, number, or boolean',
        'Error: state value cannot be NaN or Infinity; use xchain.math for numeric operations',
        'Error: state value cannot be null or undefined; use state.delete() to remove keys',
        'Error: state value exceeds max size ({this.limits.maxStateValueSize} bytes)',
        'Error: state value must be JSON-serializable'
    ]
};
const GOLDEN_THROW_TEXTS_SHA256 = '7dabd6e9c4d9e576b26d29b8ad5085787f864d1b014a2e82019174f6893bd186';

// Trigger each host error a contract can catch from state, math and emit, at the default limits.
function hostApiMessages() {
    const limits = resolveLimits(undefined);
    const caught = (fn) => {
        try { fn(); } catch (e) { return e.constructor.name + ': ' + e.message; }
        return 'no throw';
    };
    const gated = () => new StateManager({}, limits, { rejectNulKeys: true, normalizeKeys: true });
    const full = {};
    for (let i = 0; i < limits.maxStateKeys; i++) full['k' + i] = 1;
    const math = buildMathAPI(null);
    const collector = new EmissionCollector(limits.maxEmissions, true);
    return [
        caught(() => gated().set({}, 1)),
        caught(() => gated().set('k'.repeat(1025), 1)),
        caught(() => gated().set('a\u0000b', 1)),
        caught(() => gated().set('a', null)),
        caught(() => gated().set('a', Infinity)),
        caught(() => gated().set('a', () => 1)),
        caught(() => gated().set('a', 'x'.repeat(limits.maxStateValueSize))),
        caught(() => new StateManager(full, limits, {}).set('new', 1)),
        caught(() => math.add('1'.repeat(300), '1')),
        caught(() => math.divide('1', '0')),
        caught(() => math.sqrt('-1')),
        caught(() => math.log('0')),
        caught(() => { for (let i = 0; i <= limits.maxEmissions; i++) collector.add('x', {}); })
    ];
}

const CATCHING_CONTRACT = `module.exports = function(){
    try { xchain.state.set('a', null); } catch (e) { xchain.state.set('err_null', e.message); }
    try { xchain.state.set('k'.repeat(2000), 1); } catch (e) { xchain.state.set('err_key', e.message); }
    try { xchain.math.divide('1', '0'); } catch (e) { xchain.state.set('err_div', e.message); }
    return 'ok';
};`;

describe('consensus parameters are frozen (track 8 guard)', function () {
    it('host APIs throw the frozen contract-visible messages at the default limits', function () {
        assert.deepStrictEqual(hostApiMessages(), [
            'Error: state key must be a string, number, or boolean',
            'Error: state key exceeds max size (1024 bytes)',
            'Error: state key contains a NUL (0x00) byte',
            'Error: state value cannot be null or undefined; use state.delete() to remove keys',
            'Error: state value cannot be NaN or Infinity; use xchain.math for numeric operations',
            'Error: state value must be JSON-serializable',
            'Error: state value exceeds max size (65536 bytes)',
            'Error: contract exceeds max state keys (10000)',
            'ContractRevertError: math error: math input exceeds maximum length (256 chars)',
            'ContractRevertError: math error: Division by zero',
            'ContractRevertError: math error: result is not a real number',
            'ContractRevertError: math error: result is not a finite number',
            'Error: emission limit exceeded (50)'
        ], DRIFT);
    });

    it('every throw site in the bridged host modules keeps its frozen text', function () {
        const actual = {};
        for (const rel of requireClosure()) actual[rel] = throwTexts(rel);
        assert.deepStrictEqual(actual, GOLDEN_THROW_TEXTS, DRIFT);
        const digest = crypto.createHash('sha256').update(JSON.stringify(actual)).digest('hex');
        assert.strictEqual(digest, GOLDEN_THROW_TEXTS_SHA256, DRIFT);
    });

    (XChainVM ? it : it.skip)('a contract that catches a host error stores its exact text', async function () {
        this.timeout(30000);
        const vm = createVM({ gasCeiling: 1000000 });
        vm.beginBlock();
        const result = await execute(vm, CATCHING_CONTRACT, {
            network: 'regtest',
            blockContext: { height: 1, timestamp: 1786060800, hash: 'h' }
        });
        vm.endBlock();
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(result.stateChanges, [
            { key: 'err_null', value: 'state value cannot be null or undefined; use state.delete() to remove keys' },
            { key: 'err_key', value: 'state key exceeds max size (1024 bytes)' },
            { key: 'err_div', value: '\x03REVERT:math error: Division by zero' }
        ], DRIFT);
    });
});
