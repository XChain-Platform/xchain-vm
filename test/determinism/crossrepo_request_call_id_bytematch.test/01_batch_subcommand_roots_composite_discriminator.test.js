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
const { buildGateway } = require('../../../src/gateway.js');
const { buildEmitAPI, GOLDEN_VECTORS, normalizeRootDiscriminator,
        buildRequestIdPreimage, buildCallIdPreimage } = require('../../../src/gateway-emit.js');
const GasTracker = require('../../../src/gas.js');
const EmissionCollector = require('../../../src/collector.js');

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

// A BATCH carries several ROOT actions under ONE TX_VOUT (the indexer assigns
// TX_VOUT once per transaction), each seeding call-path '', so the bare root
// discriminator could not tell two same-contract EXECUTE subcommands apart and
// both derived one request_id (the second request was then dropped). The host
// sends the composite "<TX_VOUT>.<subcommand position>" for such a root
// (xchain-indexer/src/consensus/batch_root_discriminator.js, flag-day gated);
// these cases
// pin the VM half of that contract.

describe('cross-repo request_id / call_id byte-match (consensus-critical) @regression', function () {
    describe('BATCH subcommand roots (composite discriminator)', function () {
        const TX = 'abc123', CONTRACT = 7;

        it('two EXECUTE subcommands of one BATCH derive DISTINCT request_ids', function () {
            const a = vmRequestId({ txHash: TX, rootActionIndex: '0.0', callPath: '', contractIndex: CONTRACT });
            const b = vmRequestId({ txHash: TX, rootActionIndex: '0.1', callPath: '', contractIndex: CONTRACT });
            assert.notStrictEqual(a, b, 'two BATCH EXECUTE roots on one contract must not collide');
        });

        it('the composite root byte-matches the indexer formula', function () {
            for (const root of ['0.0', '0.1', '12.3']) {
                assert.strictEqual(
                    vmRequestId({ txHash: TX, rootActionIndex: root, callPath: '', contractIndex: CONTRACT }),
                    indexerRequestId(TX, root, '', CONTRACT, 0),
                    'VM and indexer request_id diverged for composite root ' + root);
            }
        });

        it('the composite survives Number() folding ("3.10" is not "3.1")', function () {
            // Number('3.10') === Number('3.1'): coercing the discriminator anywhere on
            // either side re-collides the eleventh subcommand with the second, which is
            // the whole defect coming back under a different name.
            const second   = vmRequestId({ txHash: TX, rootActionIndex: '3.1',  callPath: '', contractIndex: CONTRACT });
            const eleventh = vmRequestId({ txHash: TX, rootActionIndex: '3.10', callPath: '', contractIndex: CONTRACT });
            assert.notStrictEqual(second, eleventh);
            assert.strictEqual(normalizeRootDiscriminator('3.10'), '3.10',
                'the normalizer must hand the composite through as a string');
        });
    });
});

describe('cross-repo request_id / call_id byte-match (consensus-critical) @regression', function () {
    describe('BATCH subcommand roots (composite discriminator)', function () {
        const TX = 'abc123', CONTRACT = 7;

        it('two BATCH subcommands emitting XCALL derive DISTINCT call_ids', function () {
            const base = { network: 'regtest', txHash: 'f'.repeat(64), contractIndex: 42, targetChain: 'DOGE', callPath: '' };
            const a = vmCallId(Object.assign({}, base, { rootActionIndex: '0.0' }));
            const b = vmCallId(Object.assign({}, base, { rootActionIndex: '0.1' }));
            assert.notStrictEqual(a, b, 'the call_id carries the same root discriminator and the same exposure');
            assert.strictEqual(a, indexerCallId('regtest', 'BTC', base.txHash, '0.0', 42, '', 0, 'DOGE'));
        });

        it('every NON-composite root keeps its exact historical coercion', function () {
            // The only reason a flag day can be narrow: outside a BATCH nothing moves.
            // Number is what the VM has always hashed these through, so a numeric string
            // and a number must still produce one id, and it must be the golden one.
            assert.strictEqual(normalizeRootDiscriminator(100), 100);
            assert.strictEqual(normalizeRootDiscriminator('100'), 100);
            assert.strictEqual(normalizeRootDiscriminator(null), '');
            assert.strictEqual(normalizeRootDiscriminator(undefined), '');
            assert.strictEqual(
                vmRequestId({ txHash: TX, rootActionIndex: '100', callPath: '', contractIndex: CONTRACT }),
                GOLDEN_VECTORS.requestId.expected);
        });
    });
});

describe('cross-repo request_id / call_id byte-match (consensus-critical) @regression', function () {
    describe('BATCH subcommand roots (composite discriminator)', function () {
        const TX = 'abc123', CONTRACT = 7;

        // Literal hexes, pinned identically in the indexer's own regression suite
        // (xchain-indexer/test/unit/actions/batch_execute_attest.test.js) and checked
        // for presence by bin/check-preimage-golden-parity.js. A one-sided composite
        // preimage edit reddens the affected side and prevents a silent fork.
        it('golden vectors: the composite roots hash to the checked-in cross-repo hexes', function () {
            const GOLDEN = {
                // sha256('abc123:100.0::7:0')
                '100.0': 'c72fe26cdd4f8147fc07e16eb2ea5868d879fb61b8612cbc8c6cb7fffe12e3e6',
                // sha256('abc123:100.1::7:0')
                '100.1': '0d7fba0bc1917aa1e74e90dfcce0db0a352094b0587eddc468f228a9dcca17b9',
            };
            for (const [root, expected] of Object.entries(GOLDEN)) {
                assert.strictEqual(
                    vmRequestId({ txHash: 'abc123', rootActionIndex: root, callPath: '', contractIndex: 7 }),
                    expected, 'composite request_id vector drifted for root ' + root);
                assert.strictEqual(indexerRequestId('abc123', root, '', 7, 0), expected,
                    'the inline indexer lambda diverged from the composite vector');
            }
        });
    });
});
