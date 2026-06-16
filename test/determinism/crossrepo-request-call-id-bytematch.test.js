// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// CROSS-REPO BYTE-MATCH GUARD (consensus-critical).
//
// The ATTEST request_id and XCALL call_id are derived in the VM (gateway.js /
// gateway-emit.js) and RE-derived in the indexer (xchain-indexer attest.js /
// xcall.js). If the two preimages ever drift by a single byte, every legitimate
// emission is rejected by the re-derivation → the fleet forks. The VM-side suites
// pin the VM output; the indexer-side suites pin the handler. THIS test pins the
// two against each other: it drives the REAL VM derivation and compares it to the
// indexer's exact preimage formula (copied verbatim below — keep in lockstep).
//
// Runs on Node 24 (no isolated-vm — pure gateway builders).

const assert = require('assert');
const crypto = require('crypto');
const { buildGateway } = require('../../src/gateway.js');
const { buildEmitAPI } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const EmissionCollector = require('../../src/collector.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// ── Indexer-side preimage formulas — MUST byte-match, verbatim, the strings in:
//      xchain-indexer/src/actions/attest.js  (request_id)
//      xchain-indexer/src/actions/xcall.js   (call_id)
// EMITTER_PATH = the emitter execution's callPath; EMITTER_POSITION = emissionIndex;
// ROOT_ACTION_INDEX = the per-root discriminator (deterministic root on-chain action_index).
const indexerRequestId = (txHash, rootActionIndex, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(rootActionIndex) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

const indexerCallId = (network, coin, txHash, rootActionIndex, contractIndex, emitterPath, position, targetChain) =>
    crypto.createHash('sha256')
        .update(String(network) + ':' + String(coin) + ':' + String(txHash) + ':' + String(rootActionIndex) + ':' +
                String(contractIndex) + ':' + String(emitterPath) + ':' + String(position) + ':' +
                String(targetChain))
        .digest('hex');

// ── VM-side drivers (real gateway code) ─────────────────────────────────────
function mkGas() { return { charges: [], charge(n){ this.charges.push(n); } }; }
function mkState() { const m = new Map(); return { get:k=>m.get(k), has:k=>m.has(k), set:(k,v)=>m.set(k,v), delete:k=>m.delete(k) }; }

function vmRequestId({ txHash, rootActionIndex, callPath, contractIndex }) {
    const collector = new EmissionCollector(50);
    const ro = {
        contractIndex, txHash, rootActionIndex, callPath,
        providerDeadlines: { http_get: 100 }
    };
    const gw = buildGateway(mkGas(), mkState(), collector, ro, SCHEDULE, { reverted: false });
    return gw.attestation.request('http_get', 'https://example.com', 'cb', [], { redundancy: 1, deadlineBlocks: 10 });
}

function vmCallId({ network, txHash, rootActionIndex, callPath, contractIndex, targetChain }) {
    const collector = new EmissionCollector(50);
    const emit = buildEmitAPI(new GasTracker(SCHEDULE, 1000000), collector, SCHEDULE, {
        callDepth: 0, maxCallDepth: 4, minCallGas: 5000, crossHops: 0,
        network, txHash, rootActionIndex, callPath, contractIndex,
        // sourceChain in the call_id preimage is parsed from contractAddress (C:<COIN>:<idx>).
        contractAddress: 'C:' + 'BTC' + ':' + contractIndex
    });
    return emit.crossExecute({
        targetChain, contractIndex: 99, method: 'onArrival', params: ['a'],
        gasLimit: 50000, callbackMethod: 'onResult', callbackParams: ['ctx'], deadlineBlocks: 200
    });
}

describe('cross-repo request_id / call_id byte-match (consensus-critical) @regression', function () {

    const CASES = [
        { name: 'root execution (empty call-path)', callPath: '',      rootActionIndex: 100 },
        { name: 'first-level nested emission',      callPath: '0',     rootActionIndex: 100 },
        { name: 'deep call-path',                   callPath: '1>0>3', rootActionIndex: 250 }
    ];

    describe('ATTEST request_id', function () {
        for (const c of CASES) {
            it('VM matches the indexer formula — ' + c.name, function () {
                const txHash = 'abc123', contractIndex = 7;
                const vm = vmRequestId({ txHash, rootActionIndex: c.rootActionIndex, callPath: c.callPath, contractIndex });
                const idx = indexerRequestId(txHash, c.rootActionIndex, c.callPath, contractIndex, 0);
                assert.strictEqual(vm, idx, 'VM and indexer request_id diverged for ' + c.name);
            });
        }

        it('two nested runs of the same contract derive DISTINCT request_ids (no collision)', function () {
            const a = vmRequestId({ txHash: 'abc123', rootActionIndex: 100, callPath: '0', contractIndex: 7 });
            const b = vmRequestId({ txHash: 'abc123', rootActionIndex: 100, callPath: '1', contractIndex: 7 });
            assert.notStrictEqual(a, b);
        });

        // #4244: two FOREST ROOTS under one tx (a top-level EXECUTE and a controller guard) each
        // seed callPath '' and may target the same contract — only the root discriminator
        // distinguishes them. Without it both derive the identical request_id.
        it('two forest roots under one tx (same call-path, differing root) derive DISTINCT request_ids (#4244)', function () {
            const a = vmRequestId({ txHash: 'abc123', rootActionIndex: 100, callPath: '', contractIndex: 7 });
            const b = vmRequestId({ txHash: 'abc123', rootActionIndex: 101, callPath: '', contractIndex: 7 });
            assert.notStrictEqual(a, b, 'top-level EXECUTE vs controller guard under one tx must not collide');
        });
    });

    describe('XCALL call_id', function () {
        for (const c of CASES) {
            it('VM matches the indexer formula — ' + c.name, function () {
                const network = 'regtest', coin = 'BTC', txHash = 'f'.repeat(64);
                const contractIndex = 42, targetChain = 'DOGE';
                const vm = vmCallId({ network, txHash, rootActionIndex: c.rootActionIndex, callPath: c.callPath, contractIndex, targetChain });
                // sourceChain in the VM preimage is the COIN the emit API is bound to;
                // gateway-emit derives it from contractAddress/config — here it equals coin.
                const idx = indexerCallId(network, coin, txHash, c.rootActionIndex, contractIndex, c.callPath, 0, targetChain);
                assert.strictEqual(vm, idx, 'VM and indexer call_id diverged for ' + c.name);
            });
        }

        it('two nested runs of the same contract derive DISTINCT call_ids (d631c28 regression)', function () {
            const base = { network: 'regtest', txHash: 'f'.repeat(64), contractIndex: 42, targetChain: 'DOGE', rootActionIndex: 100 };
            const a = vmCallId(Object.assign({}, base, { callPath: '0' }));
            const b = vmCallId(Object.assign({}, base, { callPath: '1' }));
            assert.notStrictEqual(a, b, 'same-contract nested runs must not collide');
        });

        // #4244 twin: two forest roots under one tx, same call-path, differing only by root.
        it('two forest roots under one tx (same call-path, differing root) derive DISTINCT call_ids (#4244)', function () {
            const base = { network: 'regtest', txHash: 'f'.repeat(64), contractIndex: 42, targetChain: 'DOGE', callPath: '' };
            const a = vmCallId(Object.assign({}, base, { rootActionIndex: 100 }));
            const b = vmCallId(Object.assign({}, base, { rootActionIndex: 101 }));
            assert.notStrictEqual(a, b, 'two forest roots must not collide on call_id');
        });
    });
});
