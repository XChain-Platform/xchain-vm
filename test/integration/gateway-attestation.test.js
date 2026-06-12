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
 * Integration tests for the xchain.attestation gateway namespace.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 ********************************************************************/
// @ts-nocheck

// 


const assert = require('assert');

let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping attestation gateway tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION:         1,
    VM_STATE_READ:          100,
    VM_STATE_WRITE:         200,
    VM_STATE_DELETE:        100,
    VM_ORACLE_READ:         100,
    VM_CROSSCHAIN_READ:     100,
    VM_ATTEST_REQUEST: 5000,
    VM_EMISSION:            500
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling:  1000000,
        limits: {
            maxCpuTimeMs:      5000,
            maxMemory:         8,
            maxEmissions:      50,
            maxStateKeys:      10000,
            maxStateValueSize: 65536,
            maxCodeSize:       65536
        }
    });
}

function baseExecOpts(extra) {
    return Object.assign({
        state:            {},
        method:           'default',
        params:           [],
        caller:           'addr1',
        contractAddress:  'C:BTC:1',
        contractIndex:    1,
        txHash:           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        blockContext:     { height: 100, timestamp: 1700000000, hash: 'abc' }
    }, extra || {});
}

(XChainVM ? describe : describe.skip)('Gateway — attestation namespace', function () {

    let vm;
    before(function () { vm = createVM(); });

    describe('request()', function () {

        it('returns a 64-char hex request_id and charges at least VM_ATTEST_REQUEST + VM_EMISSION', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request(
                        'http_get',
                        'https://example.com/foo',
                        'handleResponse',
                        ['ctx1'],
                        { redundancy: 1, deadlineBlocks: 10 }
                    );
                };`
            }));
            assert.strictEqual(result.success, true, 'execution should succeed: ' + result.error);
            let requestId = JSON.parse(result.returnValue);
            assert.strictEqual(typeof requestId, 'string');
            assert.strictEqual(requestId.length, 64);
            assert.match(requestId, /^[0-9a-f]{64}$/);
            assert(result.gasUsed >= GAS_SCHEDULE.VM_ATTEST_REQUEST + GAS_SCHEDULE.VM_EMISSION,
                'gas should include at least the attestation+emission charges, got ' + result.gasUsed);
        });

        it('queues an ATTEST v0 (request) emission with the expected shape', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request(
                        'http_get',
                        'https://example.com/bar',
                        'handleResponse',
                        [42, 'ctx'],
                        { redundancy: 3, deadlineBlocks: 20 }
                    );
                };`
            }));
            assert.strictEqual(result.success, true, 'execution should succeed: ' + result.error);
            assert.strictEqual(result.emittedActions.length, 1);
            let emission = result.emittedActions[0];
            assert.strictEqual(emission.action, 'ATTEST');
            assert.strictEqual(emission.params.providerId, 'http_get');
            assert.strictEqual(emission.params.requestPayload, 'https://example.com/bar');
            assert.strictEqual(emission.params.callbackMethod, 'handleResponse');
            assert.strictEqual(emission.params.callbackParams, JSON.stringify([42, 'ctx']));
            assert.strictEqual(emission.params.redundancy, 3);
            assert.strictEqual(emission.params.deadlineBlocks, 20);
            assert.strictEqual(typeof emission.params.requestId, 'string');
            assert.strictEqual(emission.params.requestId.length, 64);
            // Feeless request → fee fields ride as empty strings (the indexer's
            // buildActionParams emits them as trailing empties, which the wire
            // serializer trims — byte-identical to the pre-fee format).
            assert.strictEqual(emission.params.feeTick, '');
            assert.strictEqual(emission.params.feeAmount, '');
        });

        it('carries feeTick/feeAmount into the emission when provided (E1 paid attestations)', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request(
                        'http_get',
                        'https://example.com/paid',
                        'handleResponse',
                        [],
                        { redundancy: 1, deadlineBlocks: 10, feeTick: 'XCHAIN', feeAmount: '2.5' }
                    );
                };`
            }));
            assert.strictEqual(result.success, true, 'execution should succeed: ' + result.error);
            let emission = result.emittedActions[0];
            assert.strictEqual(emission.params.feeTick, 'XCHAIN');
            assert.strictEqual(emission.params.feeAmount, '2.5');
        });

        it('rejects a feeAmount with more than 8 decimal places', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'https://example.com/x', 'cb', [],
                        { redundancy: 1, feeTick: 'XCHAIN', feeAmount: '1.123456789' });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /feeAmount must be a non-negative decimal/);
        });

        it('rejects feeAmount > 0 without a feeTick', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'https://example.com/x', 'cb', [],
                        { redundancy: 1, feeAmount: '5' });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /feeTick is required when feeAmount > 0/);
        });

        it('rejects a pipe character in feeTick (wire-format injection guard)', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'https://example.com/x', 'cb', [],
                        { redundancy: 1, feeTick: 'XCH|AIN', feeAmount: '5' });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /must not contain/);
        });

        it('produces distinct request_ids for two emissions in the same tx', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var a = xchain.attestation.request('http_get', 'https://example.com/a', 'cb', [], { redundancy: 1 });
                    var b = xchain.attestation.request('http_get', 'https://example.com/a', 'cb', [], { redundancy: 1 });
                    return JSON.stringify([a, b]);
                };`
            }));
            assert.strictEqual(result.success, true, result.error);
            let [a, b] = JSON.parse(JSON.parse(result.returnValue));
            assert.notStrictEqual(a, b, 'two emissions in same tx must produce distinct request_ids');
            assert.strictEqual(result.emittedActions.length, 2);
        });

        it('produces distinct request_ids across two different tx_hashes', async function () {
            const code = `module.exports = function(xchain) {
                return xchain.attestation.request('http_get', 'https://example.com/c', 'cb', [], { redundancy: 1 });
            };`;
            const r1 = await vm.execute(baseExecOpts({ code, txHash: '1111111111111111111111111111111111111111111111111111111111111111' }));
            const r2 = await vm.execute(baseExecOpts({ code, txHash: '2222222222222222222222222222222222222222222222222222222222222222' }));
            assert.strictEqual(r1.success, true);
            assert.strictEqual(r2.success, true);
            assert.notStrictEqual(JSON.parse(r1.returnValue), JSON.parse(r2.returnValue),
                'request_ids must diverge when tx_hash differs');
        });

        it('contractIndex=0 yields a request_id distinct from an omitted contractIndex', async function () {
            // Regression: contractIndex 0 (the first contract in a block) must not
            // collapse to the same preimage as an absent contractIndex. A falsy
            // coercion (`contractIndex || ''`) made index 0 indistinguishable from
            // undefined, breaking the (tx_hash, contract_index, emission_index)
            // uniqueness guarantee for the request_id.
            const code = `module.exports = function(xchain) {
                return xchain.attestation.request('http_get', 'https://example.com/d', 'cb', [], { redundancy: 1 });
            };`;
            const rZero    = await vm.execute(baseExecOpts({ code, contractIndex: 0 }));
            const rOmitted = await vm.execute(baseExecOpts({ code, contractIndex: undefined }));
            assert.strictEqual(rZero.success, true, rZero.error);
            assert.strictEqual(rOmitted.success, true, rOmitted.error);
            assert.notStrictEqual(
                JSON.parse(rZero.returnValue),
                JSON.parse(rOmitted.returnValue),
                'contractIndex=0 must not collide with an omitted contractIndex'
            );
        });

        it('rejects redundancy values outside {1,3,5}', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'https://example.com/', 'cb', [], { redundancy: 2 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /redundancy must be 1, 3, or 5/);
        });

        it('rejects requestPayload over 8192 bytes', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var big = 'x'.repeat(9000);
                    return xchain.attestation.request('http_get', big, 'cb', [], { redundancy: 1 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /requestPayload exceeds 8192 bytes/);
        });

        it('rejects callbackParams over 1024 bytes when JSON-stringified', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var arr = [];
                    for (var i = 0; i < 200; i++) arr.push('aaaaaaaaaa');
                    return xchain.attestation.request('http_get', 'https://example.com/', 'cb', arr, { redundancy: 1 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /callbackParams JSON exceeds 1024 bytes/);
        });

        it('rejects callbackMethod over 64 bytes', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var longMethod = 'm'.repeat(65);
                    return xchain.attestation.request('http_get', 'u', longMethod, [], { redundancy: 1 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /callbackMethod must be/);
        });

        // The limit is BYTES, not characters: a multibyte name under the 64-char
        // count but over 64 UTF-8 bytes must still be rejected (regression for the
        // chars-vs-bytes mismatch — providerId/callbackMethod were checking .length
        // while requestPayload/callbackParams used byte length).
        it('rejects a multibyte callbackMethod that is <= 64 chars but > 64 bytes', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var m = '\\u20AC'.repeat(40); // 40 chars, 120 UTF-8 bytes
                    return xchain.attestation.request('http_get', 'u', m, [], { redundancy: 1 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /callbackMethod must be/);
        });

        it('rejects a multibyte providerId that is <= 32 chars but > 32 bytes', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var p = '\\u20AC'.repeat(20); // 20 chars, 60 UTF-8 bytes
                    return xchain.attestation.request(p, 'u', 'cb', [], { redundancy: 1 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /providerId must be/);
        });

        it('rejects deadlineBlocks outside [1, 100]', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'u', 'cb', [], { redundancy: 1, deadlineBlocks: 1000 });
                };`
            }));
            assert.strictEqual(result.success, false);
            assert.match(result.error || '', /deadlineBlocks must be an integer in \[1, 100\]/);
        });

        // Regression: a per-provider deadline window narrower than the global
        // [1, 100] cap must be enforced at call time. Without injection, an
        // `llm` request (window 20) with deadlineBlocks 50 passed VM validation,
        // landed on-chain, and was then silently dead-lettered by the indexer's
        // DEADLINE check — the contract callback was never invoked.
        const PROVIDER_DEADLINES = { http_get: 100, llm: 20 };

        it('rejects deadlineBlocks above the injected per-provider window (llm=20, requested 50)', async function () {
            const result = await vm.execute(baseExecOpts({
                providerDeadlines: PROVIDER_DEADLINES,
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('llm', 'judge this', 'cb', [], { redundancy: 1, deadlineBlocks: 50 });
                };`
            }));
            assert.strictEqual(result.success, false, 'over-limit llm deadline must throw at call time');
            assert.match(result.error || '', /deadlineBlocks 50 exceeds the "llm" provider window of 20 blocks/);
            assert.strictEqual(result.emittedActions.length, 0, 'no ATTEST emission should be queued when the deadline is rejected');
        });

        it('accepts deadlineBlocks at the per-provider window limit (llm=20, requested 20)', async function () {
            const result = await vm.execute(baseExecOpts({
                providerDeadlines: PROVIDER_DEADLINES,
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('llm', 'judge this', 'cb', [], { redundancy: 1, deadlineBlocks: 20 });
                };`
            }));
            assert.strictEqual(result.success, true, 'deadline at the provider limit should succeed: ' + result.error);
            assert.strictEqual(result.emittedActions.length, 1);
        });

        it('still allows a wider provider window (http_get=100, requested 100) under the same injected map', async function () {
            const result = await vm.execute(baseExecOpts({
                providerDeadlines: PROVIDER_DEADLINES,
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('http_get', 'https://example.com/', 'cb', [], { redundancy: 1, deadlineBlocks: 100 });
                };`
            }));
            assert.strictEqual(result.success, true, 'http_get within its 100-block window should succeed: ' + result.error);
            assert.strictEqual(result.emittedActions.length, 1);
        });

        it('falls back to the global [1, 100] cap when no per-provider map is injected', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.request('llm', 'judge this', 'cb', [], { redundancy: 1, deadlineBlocks: 50 });
                };`
            }));
            assert.strictEqual(result.success, true, 'without injection only the global cap applies: ' + result.error);
            assert.strictEqual(result.emittedActions.length, 1);
        });
    });

    describe('getResponse()', function () {

        it('returns null for an unknown request_id without throwing', async function () {
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    return xchain.attestation.getResponse('deadbeef');
                };`
            }));
            assert.strictEqual(result.success, true, result.error);
            assert.strictEqual(JSON.parse(result.returnValue), null);
        });

        it('returns the response when attestationData provides one', async function () {
            const storedResponse = {
                status:         'ok',
                payload:        '{"score":7}',
                providerId:     'http_get',
                blockIndex:     200,
                validatorCount: 1
            };
            const result = await vm.execute(baseExecOpts({
                code: `module.exports = function(xchain) {
                    var r = xchain.attestation.getResponse('abc123');
                    return r;
                };`,
                attestationData: {
                    getResponse: (id) => id === 'abc123' ? storedResponse : null
                }
            }));
            assert.strictEqual(result.success, true, result.error);
            let returned = JSON.parse(result.returnValue);
            assert.strictEqual(returned.status, 'ok');
            assert.strictEqual(returned.payload, '{"score":7}');
            assert.strictEqual(returned.providerId, 'http_get');
        });
    });
});
