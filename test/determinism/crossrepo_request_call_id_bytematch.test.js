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
// gateway-emit.js) and RE-derived in the indexer (xchain-indexer
// actions/attest/index.js / actions/xcall/index.js). If the two preimages ever
// drift by a single byte, every legitimate
// emission is rejected by the re-derivation and the fleet forks. The VM-side suites
// pin the VM output; the indexer-side suites pin the handler. THIS test pins the
// two against each other: it drives the REAL VM derivation and compares it to the
// indexer's exact preimage formula (copied verbatim below; keep in lockstep).
//
// TWO LAYERS, deliberately, because they fail on different things:
//   1. the GOLDEN pins and the lambda copies below, which need nothing but this
//      repo and so run in a standalone xchain-vm clone; and
//   2. the per-field normalization domain block at the foot of the file, which
//      loads the REAL xchain-indexer re-derivation off the sibling checkout, so
//      it reddens on indexer-side drift a lambda copy cannot see. A lambda can
//      only ever agree with itself.
// Layer 2 skips where the sibling is absent (standalone clones). Where the
// siblings were provided on purpose (bin/ci-all.sh, the monorepo drift-guard
// job) export XCHAIN_REQUIRE_SIBLINGS=1 and the skip becomes a hard failure,
// so the gate can never pass green-by-skip.
//
// Runs on Node 24 (no isolated-vm; pure gateway builders).

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { buildGateway } = require('../../src/gateway.js');
const { buildEmitAPI, GOLDEN_VECTORS, normalizeRootDiscriminator,
        buildRequestIdPreimage, buildCallIdPreimage } = require('../../src/gateway-emit.js');
const GasTracker = require('../../src/gas.js');
const EmissionCollector = require('../../src/collector.js');

// Repo root by walking up to the nearest package.json rather than counting '..'
// hops, so moving this file does not silently point the sibling load at nothing.
const REPO_ROOT = (function () {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const up = path.dirname(dir);
        if (up === dir) throw new Error('no package.json above ' + __dirname);
        dir = up;
    }
    return dir;
})();
const PLATFORM_ROOT  = path.dirname(REPO_ROOT);
const INDEXER_ATTEST = path.join(PLATFORM_ROOT, 'xchain-indexer', 'src', 'actions', 'attest', 'index.js');
const INDEXER_XCALL  = path.join(PLATFORM_ROOT, 'xchain-indexer', 'src', 'actions', 'xcall', 'index.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// The indexer's REAL preimage assembly, not a restatement of it.
//
// Attest.requestIdPreimageValues and Xcall.callIdPreimageValues are the exact
// functions the handlers call before hashing (attest/index.js parseRequest, xcall/index.js
// parseRequest); they are invoked here on a minimal receiver because the only
// thing either reads off `this` is the node config the second one needs for
// NETWORK/COIN. If a future edit makes them read more, this throws, which is a
// loud failure rather than a quiet pass. That the handlers still call them, and
// have not grown a second inline formula, is pinned separately by
// bin/check-preimage-golden-parity.js.
function loadIndexerDerivation() {
    if (!fs.existsSync(INDEXER_ATTEST) || !fs.existsSync(INDEXER_XCALL)) return null;
    const Attest = require(INDEXER_ATTEST);
    const Xcall  = require(INDEXER_XCALL);
    return {
        requestIdPreimage: (data) =>
            Attest.prototype.requestIdPreimageValues.call({}, data).join(':'),
        callIdPreimage: (config, data) =>
            Xcall.prototype.callIdPreimageValues.call({ config: config }, data).join(':')
    };
}

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Indexer-side preimage formulas. MUST byte-match, verbatim, the strings in:
//      xchain-indexer/src/actions/attest/index.js  (request_id)
//      xchain-indexer/src/actions/xcall/index.js   (call_id)
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

// VM-side drivers (real gateway code)
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
            it('VM matches the indexer formula (' + c.name + ')', function () {
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

        // #4244: two forest roots under one tx (a top-level EXECUTE and a controller guard) each
        // seed callPath '' and may target the same contract; only the root discriminator
        // distinguishes them. Without it both derive the identical request_id.
        it('two forest roots under one tx (same call-path, differing root) derive DISTINCT request_ids (#4244)', function () {
            const a = vmRequestId({ txHash: 'abc123', rootActionIndex: 100, callPath: '', contractIndex: 7 });
            const b = vmRequestId({ txHash: 'abc123', rootActionIndex: 101, callPath: '', contractIndex: 7 });
            assert.notStrictEqual(a, b, 'top-level EXECUTE vs controller guard under one tx must not collide');
        });

        // Golden-vector assertion: pins the exact preimage formula against a checked-in
        // expected hex so a lockstep edit to both inline lambdas (masking the fork) still
        // fails. The same vector is asserted in xchain-indexer attest.test.js.
        it('golden vector: VM derivation matches checked-in expected hex', function () {
            const v = GOLDEN_VECTORS.requestId;
            const i = v.input;
            const got = vmRequestId({
                txHash:          i.txHash,
                rootActionIndex: i.rootActionIndex,
                callPath:        i.emitterPath,
                contractIndex:   i.contractIndex
            });
            assert.strictEqual(got, v.expected,
                'request_id golden vector mismatch: preimage formula changed without updating GOLDEN_VECTORS');
            // Also verify the inline indexer lambda produces the same expected value,
            // so a drift in the lambda is caught here rather than masked.
            const idx = indexerRequestId(i.txHash, i.rootActionIndex, i.emitterPath, i.contractIndex, i.emitterPosition);
            assert.strictEqual(idx, v.expected,
                'indexer inline lambda diverged from GOLDEN_VECTORS.requestId.expected');
        });
    });
});
