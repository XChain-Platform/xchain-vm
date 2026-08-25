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
const INDEXER_ATTEST = path.join(PLATFORM_ROOT, 'xchain-indexer', 'src', 'actions', 'attest.js');
const INDEXER_XCALL  = path.join(PLATFORM_ROOT, 'xchain-indexer', 'src', 'actions', 'xcall.js');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// The indexer's REAL preimage assembly, not a restatement of it.
//
// Attest._requestIdPreimageValues and Xcall._callIdPreimageValues are the exact
// functions the handlers call before hashing (attest.js _parseRequest, xcall.js
// _parseRequest); they are invoked here on a minimal receiver because the only
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
            Attest.prototype._requestIdPreimageValues.call({}, data).join(':'),
        callIdPreimage: (config, data) =>
            Xcall.prototype._callIdPreimageValues.call({ config: config }, data).join(':')
    };
}

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// Indexer-side preimage formulas. MUST byte-match, verbatim, the strings in:
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

    // A BATCH carries several ROOT actions under ONE TX_VOUT (the indexer assigns
    // TX_VOUT once per transaction), each seeding call-path '', so the bare root
    // discriminator could not tell two same-contract EXECUTE subcommands apart and
    // both derived one request_id (the second request was then dropped). The host
    // sends the composite "<TX_VOUT>.<subcommand position>" for such a root
    // (xchain-indexer/src/batch_root_discriminator.js, flag-day gated); these cases
    // pin the VM half of that contract.
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

        // Literal hexes, pinned identically in the indexer's own regression suite
        // (xchain-indexer/test/unit/actions/batch-execute-attest.test.js) and checked
        // for presence by bin/check-preimage-golden-parity.js. A one-sided edit to the
        // composite preimage reddens that side instead of forking the fleet quietly.
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

    describe('XCALL call_id', function () {
        for (const c of CASES) {
            it('VM matches the indexer formula (' + c.name + ')', function () {
                const network = 'regtest', coin = 'BTC', txHash = 'f'.repeat(64);
                const contractIndex = 42, targetChain = 'DOGE';
                const vm = vmCallId({ network, txHash, rootActionIndex: c.rootActionIndex, callPath: c.callPath, contractIndex, targetChain });
                // sourceChain in the VM preimage is the COIN the emit API is bound to;
                // gateway-emit derives it from contractAddress/config; here it equals coin.
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

        // Golden-vector assertion: pins the exact preimage formula against a checked-in
        // expected hex so a lockstep edit to both inline lambdas (masking the fork) still
        // fails. The same vector is asserted in xchain-indexer xcall.test.js.
        it('golden vector: VM derivation matches checked-in expected hex', function () {
            const v = GOLDEN_VECTORS.callId;
            const i = v.input;
            const got = vmCallId({
                network:         i.network,
                txHash:          i.txHash,
                rootActionIndex: i.rootActionIndex,
                callPath:        i.emitterPath,
                contractIndex:   i.contractIndex,
                targetChain:     i.targetChain
            });
            assert.strictEqual(got, v.expected,
                'call_id golden vector mismatch: preimage formula changed without updating GOLDEN_VECTORS');
            // Also verify the inline indexer lambda produces the same expected value.
            const idx = indexerCallId(i.network, i.coin, i.txHash, i.rootActionIndex, i.contractIndex, i.emitterPath, i.emitterPosition, i.targetChain);
            assert.strictEqual(idx, v.expected,
                'indexer inline lambda diverged from GOLDEN_VECTORS.callId.expected');
        });

        // The hex pins catch a field skew only as an opaque hash difference.
        // Naming the count makes a dropped or added field read as what it is. The
        // indexer declares the same eight names in xchain-indexer/src/actions/xcall.js
        // (CALL_ID_PREIMAGE_FIELDS), pinned against this order by
        // bin/check-preimage-golden-parity.js.
        it('golden vector: the call_id preimage carries exactly eight fields', function () {
            const i = GOLDEN_VECTORS.callId.input;
            // No golden value contains the ':' separator, so the split count is the
            // structural field count.
            const preimage = [i.network, i.coin, i.txHash, i.rootActionIndex,
                              i.contractIndex, i.emitterPath, i.emitterPosition,
                              i.targetChain].map(String).join(':');
            assert.strictEqual(preimage.split(':').length, 8,
                'call_id preimage field count changed; the indexer must change in lockstep');
            assert.strictEqual(crypto.createHash('sha256').update(preimage).digest('hex'),
                GOLDEN_VECTORS.callId.expected);
        });
    });

    // ---- per-field normalization domain ------------------------------------
    //
    // The two sides agree, but they agree by applying DIFFERENT operations to the
    // same fields and landing on the same bytes. The VM folds contractIndex through
    // Number() and rootActionIndex through normalizeRootDiscriminator; the indexer
    // bare-String()s both (attest.js, where CONTRACT_INDEX has additionally become a
    // mathjs bignumber via util.setNumberFormats). Agreement therefore rests on an
    // unstated invariant about what the input domain contains, not on shared code.
    //
    // The cases above all sit INSIDE that domain, so they cannot say where its edge
    // is. These do: the safe half asserts agreement, and the unsafe half MEASURES the
    // divergence each excluded shape produces. That second half is not a blessing of
    // the asymmetry - it is the domain boundary written down. Widening a producer to
    // emit one of these shapes splits request_ids silently (the id is xchain-hub's
    // cross-chain join key, so the failure mode is stranded legs, not an error).
    //
    // BOTH halves here are the REAL code, and that is the point of this block.
    // The VM half is buildRequestIdPreimage / buildCallIdPreimage, the exported
    // assembly gateway.js and crossExecute themselves call, so the matrix cannot
    // drift away from what the VM emits. The indexer half is loaded off the
    // sibling checkout (Attest._requestIdPreimageValues, Xcall._callIdPreimageValues),
    // so it reddens when the INDEXER's coercion moves. The previous version of this
    // block restated both formulas as local lambdas, which meant it could only ever
    // measure itself: an indexer-side edit left every row green.
    describe('per-field normalization domain (VM folds, indexer stringifies)', function () {
        const TXH = 'abc123', POS = 0;
        const COIN_CONFIG = { NETWORK: 'regtest', COIN: 'BTC' };
        let IDX = null;

        before(function () {
            IDX = loadIndexerDerivation();
            if (IDX) return;
            if (REQUIRE_SIBLINGS) {
                assert.fail('the per-field normalization matrix needs the real xchain-indexer ' +
                    'derivation at ' + INDEXER_ATTEST + ' and ' + INDEXER_XCALL +
                    '; XCHAIN_REQUIRE_SIBLINGS=1 forbids the green-by-skip');
            }
            this.skip();
        });

        const vmPreimage = (root, callPath, contractIndex) =>
            buildRequestIdPreimage({
                txHash: TXH, rootActionIndex: root, callPath: callPath,
                contractIndex: contractIndex, emissionIndex: POS
            });
        const indexerPreimage = (root, callPath, contractIndex) =>
            IDX.requestIdPreimage({
                TX_HASH:           TXH,
                ROOT_ACTION_INDEX: root,
                EMITTER_PATH:      callPath,
                CONTRACT_INDEX:    contractIndex,
                EMITTER_POSITION:  POS
            });

        // Everything a producer emits today: integer TX_VOUT roots, the numeric-string
        // form of the same, "<vout>.<position>" BATCH composites, integer contract
        // indexes.
        const IN_DOMAIN = [
            { name: 'integer root',            root: 100,     contractIndex: 7 },
            { name: 'numeric-string root',     root: '100',   contractIndex: 7 },
            { name: 'zero root',               root: 0,       contractIndex: 0 },
            { name: 'BATCH composite root',    root: '3.10',  contractIndex: 7 },
            { name: 'BATCH composite root .0', root: '100.0', contractIndex: 7 },
        ];

        for (const c of IN_DOMAIN) {
            it('agrees on ' + c.name, function () {
                assert.strictEqual(vmPreimage(c.root, '', c.contractIndex),
                                   indexerPreimage(c.root, '', c.contractIndex),
                                   'in-domain input ' + c.name + ' no longer byte-matches');
                // And gateway.js itself routes through the shared assembly: the id a
                // real attestation.request emits is the hash of exactly these bytes.
                // A call site that grew its own inline formula again fails here.
                assert.strictEqual(
                    vmRequestId({ txHash: TXH, rootActionIndex: c.root, callPath: '', contractIndex: c.contractIndex }),
                    crypto.createHash('sha256').update(vmPreimage(c.root, '', c.contractIndex)).digest('hex'),
                    'gateway.js no longer derives the request_id from buildRequestIdPreimage for ' + c.name);
            });
        }

        // Each entry: a shape no producer emits today, and the exact bytes each side
        // would hash if one ever did.
        const OUT_OF_DOMAIN = [
            { name: 'zero-padded contract index', root: 100, contractIndex: '007',
              vm: 'abc123:100::7:0',    indexer: 'abc123:100::007:0' },
            { name: 'zero-padded root',           root: '007', contractIndex: 7,
              vm: 'abc123:7::7:0',      indexer: 'abc123:007::7:0' },
            { name: 'three-part discriminator',   root: '100.0.1', contractIndex: 7,
              vm: 'abc123:NaN::7:0',    indexer: 'abc123:100.0.1::7:0' },
            { name: 'exponential-notation root',  root: '1e3', contractIndex: 7,
              vm: 'abc123:1000::7:0',   indexer: 'abc123:1e3::7:0' },
            { name: 'decimal-string contract index past 2^53', root: 100,
              contractIndex: '1000000000000000000000',
              vm: 'abc123:100::1e+21:0', indexer: 'abc123:100::1000000000000000000000:0' },
            { name: 'signed-zero root',           root: '-0', contractIndex: 7,
              vm: 'abc123:0::7:0',      indexer: 'abc123:-0::7:0' },
            { name: 'whitespace-padded root',     root: ' 7 ', contractIndex: 7,
              vm: 'abc123:7::7:0',      indexer: 'abc123: 7 ::7:0' },
        ];

        for (const c of OUT_OF_DOMAIN) {
            it('splits on ' + c.name + ' (excluded from the input domain)', function () {
                const vm  = vmPreimage(c.root, '', c.contractIndex);
                const idx = indexerPreimage(c.root, '', c.contractIndex);
                assert.strictEqual(vm, c.vm,
                    'the VM half of the ' + c.name + ' case moved; re-derive this row');
                assert.strictEqual(idx, c.indexer,
                    'the indexer half of the ' + c.name + ' case moved; re-derive this row');
                assert.notStrictEqual(vm, idx,
                    c.name + ' now byte-matches. Either the two sides were unified (delete ' +
                    'this row and the domain caveat with it) or one side changed and the ' +
                    'agreement is a new coincidence, not a fix.');
            });
        }

        it('the VM applies its folds to exactly two of the five fields', function () {
            // txHash and callPath ride through as strings on both sides, and the
            // emission index is a VM-local integer. Naming that keeps the domain
            // caveat scoped: only rootActionIndex and contractIndex carry the risk.
            assert.strictEqual(vmPreimage(100, 'a>b', 7), indexerPreimage(100, 'a>b', 7));
            assert.strictEqual(vmPreimage(100, '007>1e3', 7), indexerPreimage(100, '007>1e3', 7),
                'callPath must pass through unfolded on both sides');
        });

        // The call_id carries the same two folded fields plus network/coin/target
        // chain, and its indexer half is a SECOND hand-written re-derivation
        // (xcall.js _callIdPreimageValues). Driving both real implementations over
        // the same rows is what makes an xcall.js-only coercion edit visible here.
        const vmCallPreimage = (root, callPath, contractIndex) =>
            buildCallIdPreimage({
                network:     COIN_CONFIG.NETWORK, sourceChain: COIN_CONFIG.COIN,
                txHash:      TXH,        rootActionIndex: root,
                contractIndex: contractIndex, callPath: callPath,
                emissionIndex: POS,      targetChain: 'DOGE'
            });
        const indexerCallPreimage = (root, callPath, contractIndex) =>
            IDX.callIdPreimage(COIN_CONFIG, {
                TX_HASH:           TXH,
                ROOT_ACTION_INDEX: root,
                CONTRACT_INDEX:    contractIndex,
                EMITTER_PATH:      callPath,
                EMITTER_POSITION:  POS,
                TARGET_CHAIN:      'DOGE'
            });

        for (const c of IN_DOMAIN) {
            it('call_id agrees on ' + c.name, function () {
                assert.strictEqual(vmCallPreimage(c.root, '', c.contractIndex),
                                   indexerCallPreimage(c.root, '', c.contractIndex),
                                   'in-domain call_id input ' + c.name + ' no longer byte-matches');
                // And crossExecute routes through the shared assembly, same as above.
                assert.strictEqual(
                    vmCallId({ network: COIN_CONFIG.NETWORK, txHash: TXH, rootActionIndex: c.root,
                               callPath: '', contractIndex: c.contractIndex, targetChain: 'DOGE' }),
                    crypto.createHash('sha256').update(vmCallPreimage(c.root, '', c.contractIndex)).digest('hex'),
                    'gateway-emit.js no longer derives the call_id from buildCallIdPreimage for ' + c.name);
            });
        }

        // The lambda copies at the head of this file back every assertion that has
        // to run in a standalone clone, where there is no indexer to read. Nothing
        // else proves they still describe the indexer, so pin them against it here,
        // on the golden tuples both repos already pin independently.
        it('the standalone lambda copies still match the real indexer derivation', function () {
            const r = GOLDEN_VECTORS.requestId.input;
            assert.strictEqual(
                indexerRequestId(r.txHash, r.rootActionIndex, r.emitterPath, r.contractIndex, r.emitterPosition),
                crypto.createHash('sha256').update(IDX.requestIdPreimage({
                    TX_HASH: r.txHash, ROOT_ACTION_INDEX: r.rootActionIndex,
                    EMITTER_PATH: r.emitterPath, CONTRACT_INDEX: r.contractIndex,
                    EMITTER_POSITION: r.emitterPosition
                })).digest('hex'),
                'the request_id lambda copy drifted from xchain-indexer attest.js');

            const v = GOLDEN_VECTORS.callId.input;
            assert.strictEqual(
                indexerCallId(v.network, v.coin, v.txHash, v.rootActionIndex, v.contractIndex,
                              v.emitterPath, v.emitterPosition, v.targetChain),
                crypto.createHash('sha256').update(IDX.callIdPreimage(
                    { NETWORK: v.network, COIN: v.coin },
                    { TX_HASH: v.txHash, ROOT_ACTION_INDEX: v.rootActionIndex,
                      CONTRACT_INDEX: v.contractIndex, EMITTER_PATH: v.emitterPath,
                      EMITTER_POSITION: v.emitterPosition, TARGET_CHAIN: v.targetChain }
                )).digest('hex'),
                'the call_id lambda copy drifted from xchain-indexer xcall.js');
        });
    });
});
