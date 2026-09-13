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
// PROVIDER-ENVELOPE DRIFT GUARD (VM literals <-> indexer provider registry).
//
// gateway.js enforces the attestation envelope asymmetrically: the deadline
// ceiling is INJECTED per provider (readOnlyData.providerDeadlines), while the
// payload cap (8192), the redundancy set ([1, 3, 5]) and the outer deadline
// range ([1, 100]) are literals. The indexer then enforces the real per-provider
// values, and a request that fails there is recorded terminal 'rejected' at
// creation: it never enters the pending pool, so the contract's callback never
// fires. Every literal below is therefore a place where VM and host can drift
// apart silently, one contract at a time.
//
// One drift is LIVE and deliberate, not a bug this file can fix: http_get's
// max_request_bytes is 2048 while the VM cap is 8192, so a 2049..8192-byte
// http_get payload is accepted here, charged VM_ATTEST_REQUEST gas, and then
// stranded host-side. Closing it means injecting the whole envelope the way
// deadlines already are, which tightens a consensus-visible VM outcome and needs
// its own mirrored activation pair across both repos. Until that lands, the gap
// is pinned below so it stays a known, tested quantity rather than a surprise,
// and any other movement on either side of the seam turns red.
//
// Runs without isolated-vm (pure gateway builders), like
// test/determinism/crossrepo-request-call-id-bytematch.test.js.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { buildGateway }  = require('../../src/gateway.js');
const EmissionCollector = require('../../src/collector.js');

const REGISTRY_FILE = path.join(__dirname, '..', '..', '..', 'xchain-indexer',
                                'src', 'attestation', 'providerRegistry.js');

// VM-side literals under guard (gateway.js attestation.request).
const VM_PAYLOAD_CAP     = 8192;
const VM_REDUNDANCY_SET  = [1, 3, 5];
const VM_DEADLINE_MIN    = 1;
const VM_DEADLINE_MAX    = 100;

// Required-sibling gate, same contract as lint-parity.test.js: a missing
// xchain-indexer checkout skips (local dev, standalone-repo CI), but the job
// that PROVIDES the siblings sets XCHAIN_REQUIRE_SIBLINGS=1 and a miss is a
// hard failure there, so this seam cannot pass green by being skipped.
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function requireSiblingOrSkip(ctx, present, what) {
    if (present) return;
    if (REQUIRE_SIBLINGS)
        assert.fail('required sibling missing under XCHAIN_REQUIRE_SIBLINGS=1: ' + what);
    ctx.skip();
}

const haveRegistry = fs.existsSync(REGISTRY_FILE);
const PROVIDERS = haveRegistry ? require(REGISTRY_FILE).PROVIDERS : null;

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function mkGas()   { return { charges: [], charge(n) { this.charges.push(n); } }; }
function mkState() { const m = new Map(); return { get: k => m.get(k), has: k => m.has(k),
                                                   set: (k, v) => m.set(k, v), delete: k => m.delete(k) }; }

function requestPayloadOfSize(bytes) {
    return 'https://example.com/?q=' + 'a'.repeat(bytes - 'https://example.com/?q='.length);
}

function vmRequest(payload) {
    const ro = {
        contractIndex: 1, txHash: 'aa'.repeat(32), rootActionIndex: 0, callPath: '0',
        providerDeadlines: { http_get: 100 }
    };
    const gw = buildGateway(mkGas(), mkState(), new EmissionCollector(50), ro, SCHEDULE, { reverted: false });
    return gw.attestation.request('http_get', payload, 'cb', [], { redundancy: 1, deadlineBlocks: 10 });
}

describe('attestation provider envelope (VM literals vs the indexer registry)', function () {

    it('caps payloads at the LARGEST registered max_request_bytes, so no provider is under-served', function () {
        requireSiblingOrSkip(this, haveRegistry, REGISTRY_FILE);
        const largest = Math.max(...Object.values(PROVIDERS).map(p => p.max_request_bytes));
        assert.strictEqual(largest, VM_PAYLOAD_CAP,
            'ENVELOPE DRIFT: the VM payload cap (' + VM_PAYLOAD_CAP + ') no longer equals the largest '
            + 'registered provider max_request_bytes (' + largest + '). Above it the VM rejects payloads '
            + 'the host would accept; below it the silent-stranding window widens.');
    });

    it('admits exactly the redundancy values every registered provider allows', function () {
        requireSiblingOrSkip(this, haveRegistry, REGISTRY_FILE);
        for (const p of Object.values(PROVIDERS)) {
            assert.deepStrictEqual(p.allowed_redundancy, VM_REDUNDANCY_SET,
                'ENVELOPE DRIFT: provider ' + p.provider_id + ' allows '
                + JSON.stringify(p.allowed_redundancy) + ' but the VM literal is '
                + JSON.stringify(VM_REDUNDANCY_SET) + '; a narrowed provider set strands the callback '
                + 'host-side, a widened one is rejected at call time.');
        }
    });

    it('keeps every registered deadline window inside the VM [1, 100] safety net', function () {
        requireSiblingOrSkip(this, haveRegistry, REGISTRY_FILE);
        for (const p of Object.values(PROVIDERS)) {
            assert.ok(p.deadline_window_blocks >= VM_DEADLINE_MIN && p.deadline_window_blocks <= VM_DEADLINE_MAX,
                'ENVELOPE DRIFT: provider ' + p.provider_id + ' window is ' + p.deadline_window_blocks
                + ' blocks, outside the VM range [' + VM_DEADLINE_MIN + ', ' + VM_DEADLINE_MAX + ']; the '
                + 'injected providerDeadlines map cannot widen past the literal.');
        }
    });

    // KNOWN GAP, pinned deliberately. When the per-provider envelope injection
    // lands behind its activation pair, this call starts throwing and this test
    // must be inverted in the same change: that is the point of pinning it.
    it('still accepts an over-provider http_get payload (the live, documented stranding gap)', function () {
        requireSiblingOrSkip(this, haveRegistry, REGISTRY_FILE);
        const providerCap = PROVIDERS.http_get.max_request_bytes;
        assert.ok(providerCap < VM_PAYLOAD_CAP, 'gap closed at the registry: re-derive this pin');
        const payload = requestPayloadOfSize(providerCap + 2048);
        const requestId = vmRequest(payload);
        assert.match(requestId, /^[0-9a-f]{64}$/,
            'the VM accepted the over-provider payload and must return a request_id');
    });

    it('rejects a payload over the platform-wide cap at call time', function () {
        const tooBig = requestPayloadOfSize(VM_PAYLOAD_CAP + 1);
        assert.throws(() => vmRequest(tooBig), /requestPayload exceeds 8192 bytes/);
    });
});
