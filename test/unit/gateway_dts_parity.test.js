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

const DTS_PATH = path.join(__dirname, '../../src/gateway.d.ts');
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

// The getTokenInfo payload is built UPPERCASE with an integer DECIMALS by the
// indexer (buildVmBalancesAndTokenInfo) and passed through untouched, and nine
// value-holding templates feed info.DECIMALS to floorToDecimals. A lowercase
// member on TokenInfo makes info.decimals type-check and read undefined, which
// floorToDecimals answers with the integer part rather than a revert, so the
// casing and the numeric type are pinned here the way method names are above.
describe('gateway.d.ts TokenInfo matches the runtime token-info payload', function () {
    const body = (function () {
        const open = DTS.indexOf('export interface TokenInfo {');
        assert.ok(open >= 0, 'TokenInfo interface missing from gateway.d.ts');
        const close = DTS.indexOf('\n}', open);
        assert.ok(close > open, 'TokenInfo interface is unterminated');
        return DTS.substring(open, close);
    }());

    // Member names only: `NAME:` or `NAME?:` at the head of a line, so doc-comment
    // prose inside the interface cannot be mistaken for a declaration.
    const members = [];
    const memberRe = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\??[ \t]*:/gm;
    let m;
    while ((m = memberRe.exec(body)) !== null) members.push(m[1]);

    it('declares every key the token-info payload carries', function () {
        const MockLedger = require('../e2e/helpers/MockLedger.js');
        const ledger = new MockLedger();
        ledger.setTokenDecimals('TOK', 8);
        const emitted = Object.keys(ledger.buildTokenInfoMap().TOK);
        const missing = emitted.filter((k) => !members.includes(k));
        assert.deepStrictEqual(missing, [], 'token-info keys missing from TokenInfo: ' + missing.join(', '));
    });

    it('types DECIMALS as a number, not a string', function () {
        assert.ok(/\bDECIMALS\??\s*:\s*number\b/.test(body), 'DECIMALS must be typed number in TokenInfo');
    });

    it('declares no lowercase member and no open index signature', function () {
        const lowercase = members.filter((k) => k !== k.toUpperCase());
        assert.deepStrictEqual(lowercase, [], 'lowercase TokenInfo members read undefined at runtime: ' + lowercase.join(', '));
        assert.ok(!/\[\s*key\s*:\s*string\s*\]/.test(body), 'an index signature lets a misspelled key type-check');
    });
});
