// @ts-nocheck
//
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Drift guard for src/gateway.d.ts (the typed in-contract `xchain` gateway
// shipped for editor autocomplete). Builds the real runtime gateway and asserts
// every top-level method, every namespace, and every namespace member has a
// declaration in the .d.ts. A method added to gateway.js / gateway-emit.js /
// math.js without a matching type here fails this test, so the published types
// can never silently fall behind the runtime surface authors call. Pure host
// functions, no isolate, so it runs on any Node.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildGateway } = require('../../src/gateway.js');

const DTS_PATH = path.join(__dirname, '..', '..', 'src', 'gateway.d.ts');
const DTS = fs.readFileSync(DTS_PATH, 'utf8');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function buildRealGateway() {
    const gas = { charges: [], ceiling: 1000000, used: 0, charge(n) { this.charges.push(n); this.used += n; } };
    const state = { get() {}, has() {}, set() {}, delete() {} };
    const collector = { actions: [], add() {}, addLog() {}, isLogFull() { return false; }, getLogCount() { return 0; } };
    const readOnly = {
        caller: 'c', contractAddress: 'C:BTC:1', contractIndex: 1, txHash: 'tx',
        params: [], blockContext: { height: 1, timestamp: 1, hash: 'h' },
        callDepth: 0, maxCallDepth: 4, minCallGas: 5000, crossHops: 0, network: 'regtest'
    };
    return buildGateway(gas, state, collector, readOnly, SCHEDULE, { reverted: false });
}

// Declared as a member name somewhere in the .d.ts? Matches `name(` (a method
// signature) or `name:` (a property), word-boundaried so `log` does not match
// `log2`/`log10`.
function declared(name) {
    return new RegExp('(?:^|[^A-Za-z0-9_])' + name + '\\s*[(:<]').test(DTS);
}

describe('gateway.d.ts parity with the runtime gateway', function () {
    const gw = buildRealGateway();

    const NAMESPACES = ['state', 'oracle', 'crossChain', 'attestation', 'contract', 'emit', 'math'];

    it('the .d.ts exists and declares the XChainGateway interface', function () {
        assert.ok(/interface XChainGateway/.test(DTS), 'XChainGateway interface missing');
    });

    it('every top-level gateway member is typed', function () {
        const missing = Object.keys(gw).filter((k) => !declared(k));
        assert.deepStrictEqual(missing, [], 'gateway members missing from gateway.d.ts: ' + missing.join(', '));
    });

    it('exposes exactly the expected namespaces', function () {
        for (const ns of NAMESPACES) {
            assert.strictEqual(typeof gw[ns], 'object', 'runtime gateway missing namespace: ' + ns);
            assert.ok(declared(ns), 'namespace not typed: ' + ns);
        }
    });

    for (const ns of ['state', 'oracle', 'crossChain', 'attestation', 'contract', 'emit', 'math']) {
        it('every ' + ns + '.* member is typed', function () {
            const gw2 = buildRealGateway();
            const members = Object.keys(gw2[ns]).filter((k) => typeof gw2[ns][k] === 'function');
            const missing = members.filter((k) => !declared(k));
            assert.deepStrictEqual(missing, [], ns + ' members missing from gateway.d.ts: ' + missing.join(', '));
        });
    }
});
