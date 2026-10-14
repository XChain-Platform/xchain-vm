/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Reads the harness surface a contract can observe: the source text of every
 * xchain.* function and of the JSON and join/flat wrappers (String(fn)), the gas
 * that read costs, and the name, message and stack text of errors thrown by the
 * host and inside the isolate. test/fixtures/host_call_surface_develop.json holds
 * this reading taken from the develop harness the host-call bounds change started from.
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');

const CTX = { contractAddress: 'C:BTC:7', contractIndex: 7, txHash: 'f'.repeat(64),
    rootActionIndex: 3, callPath: '', actionIndex: 11 };
const BLOCK = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const fn = (body) => 'module.exports = function(xchain) { ' + body + ' };';
const FILL = 'for (var i = 0; i < 50; i++) xchain.emit.broadcast({});';
const caught = (call) => 'try { ' + call + '; } catch (e) { return [e.name, e.message, e.stack]; } return 0;';

// Natives the harness wraps beside the xchain object.
const EXTRA_FUNCTIONS = ['JSON.stringify', 'JSON.parse', 'Array.prototype.join', 'Array.prototype.flat'];

// One host throw per gateway family the change touches, plus the in-isolate control.
const THROWS = {
    emitParams: caught('xchain.emit.send(5)'),
    stateKey: caught('xchain.state.set({}, 1)'),
    capBroadcast: FILL + caught('xchain.emit.broadcast({})'),
    capExecute: FILL + caught("xchain.emit.execute({ contractIndex: 9, method: 'm', gasLimit: 400000 })"),
    capCrossExecute: FILL + caught("xchain.emit.crossExecute({ targetChain: 'LTC', contractIndex: 9, " +
        "method: 'm', gasLimit: 200000, callbackMethod: 'cb' })"),
    capAttestation: FILL + caught("xchain.attestation.request('llm', 'p', 'cb', [])"),
    attestationProvider: caught("xchain.attestation.request('', 'p', 'cb', [])"),
    revert: caught("xchain.revert('r')"),
    inIsolate: caught('null.x'),
};

// Every function reachable from xchain, walked the way a contract would walk it.
const LIST_FUNCTIONS = "var o = []; (function w(p, x, d) { if (d > 3) return; for (var k in x) { var v; " +
    "try { v = x[k]; } catch (e) { continue; } var q = p + '.' + k; if (typeof v === 'function') o.push(q); " +
    "else if (v && typeof v === 'object') w(q, v, d + 1); } })('xchain', xchain, 0); return o;";

async function runOnce(createVM, network, body) {
    const vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    try {
        return await vm.execute(Object.assign({ code: fn(body), state: {}, method: 'default', params: [],
            caller: 'a', network, blockContext: BLOCK }, CTX));
    } finally { vm.endBlock(); }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function readFunctions(createVM, network) {
    const listed = await runOnce(createVM, network, LIST_FUNCTIONS);
    const paths = JSON.parse(listed.returnValue).concat(EXTRA_FUNCTIONS);
    const out = {};
    for (const p of paths) {
        const r = await runOnce(createVM, network, 'return String(' + p + ');');
        out[p] = { success: r.success, gasUsed: r.gasUsed, sourceSha256: sha256(r.returnValue) };
    }
    return out;
}

async function readThrows(createVM, network) {
    const out = {};
    for (const [name, body] of Object.entries(THROWS)) {
        const r = await runOnce(createVM, network, body);
        out[name] = { success: r.success, gasUsed: r.gasUsed, returnValue: r.returnValue };
    }
    return out;
}

async function readSurface(createVM, network) {
    return { functions: await readFunctions(createVM, network), throws: await readThrows(createVM, network) };
}

module.exports = { readSurface, THROWS };
