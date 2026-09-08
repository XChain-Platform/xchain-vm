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
// readManifest(): the contract-identity report (CONTRACT_META_REQUIRED).
//
// The wrapper reports four fields beside the permissions manifest: metaType,
// metaJson, metaError and metaOversize. It never judges: the seven verdict
// strings live host-side in xchain-indexer/src/actions/deploy.js. These vectors
// pin the REPORT, one per shape the indexer has to tell apart, plus the
// invariant the whole design rests on: reading meta can never make the manifest
// read fail, because that would move the existing permissions verdicts.

const assert = require('assert');

// Requires isolated-vm. Skip if unavailable (e.g. Node != 22). Mirrors sibling tests.
let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping contract-meta-report tests (isolated-vm not available):', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// The cap the wrapper enforces, in UTF-16 code units of the serialised meta.
const META_JSON_MAX_CHARS = 4096;

(XChainVM ? describe : describe.skip)('readManifest contract-meta report', function () {

    let vm;
    before(function () {
        vm = new XChainVM({
            gasSchedule: GAS_SCHEDULE,
            gasCeiling: 1000000,
            limits: {
                maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
                maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
            }
        });
    });

    // Every vector reads a manifest and asserts on manifest fields, so the read
    // itself succeeding is part of every assertion.
    async function report(code) {
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true, 'manifest read must succeed: ' + res.error);
        assert.ok(res.manifest, 'manifest must be present');
        return res.manifest;
    }

    it('reports an object meta with its serialised bytes', async function () {
        const code = "module.exports = { meta: { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' }, permissions: ['SEND'] };";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, false);
        assert.strictEqual(m.metaOversize, false);
        // Byte-for-byte, key order included: the host stores this string as-is.
        assert.strictEqual(m.metaJson,
            '{"name":"Escrow","description":"Two-party escrow with an arbiter","version":"1.0.0"}');
        assert.deepStrictEqual(JSON.parse(m.metaJson),
            { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' });
    });

    it('reports meta hung off a FUNCTION export (the function-style contract stays deployable)', async function () {
        const code = "function contract(xchain) { return 'ok'; }\n"
                   + "contract.meta = { name: 'Ping', description: 'Returns ok' };\n"
                   + "module.exports = contract;";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, false);
        assert.strictEqual(m.metaJson, '{"name":"Ping","description":"Returns ok"}');
    });

    it('reports metaType undefined for a function export carrying no meta', async function () {
        const code = "module.exports = function contract(xchain) { return 'ok'; };";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'undefined');
        assert.strictEqual(m.metaJson, null);
        assert.strictEqual(m.metaError, false);
        assert.strictEqual(m.metaOversize, false);
    });

    it('distinguishes meta: null from an absent meta', async function () {
        const m = await report("module.exports = { meta: null, permissions: [] };");
        assert.strictEqual(m.metaType, 'null');
        assert.strictEqual(m.metaJson, null);
        assert.strictEqual(m.metaError, false);
    });

    it('distinguishes an ARRAY meta from an object (typeof would say object)', async function () {
        const m = await report("module.exports = { meta: ['Escrow'] };");
        assert.strictEqual(m.metaType, 'array');
        assert.strictEqual(m.metaJson, null, 'an array is never serialised into metaJson');
        assert.strictEqual(m.metaError, false);
    });

    it('reports a primitive meta with its real type', async function () {
        const m = await report("module.exports = { meta: 'Escrow' };");
        assert.strictEqual(m.metaType, 'string');
        assert.strictEqual(m.metaJson, null);
        assert.strictEqual(m.metaError, false);
    });

    it('reports metaError for a Date (it serialises to a string, not an object)', async function () {
        // Date is stripped from the sandbox global scope, so the vector builds the
        // same shape the check is about: an object whose toJSON yields a string.
        const m = await report("module.exports = { meta: { toJSON: function () { return '2026-09-08T00:00:00.000Z'; } } };");
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
        assert.strictEqual(m.metaOversize, false);
    });

    it('reports metaError for a CIRCULAR meta', async function () {
        const code = "var m = { name: 'Loop', description: 'circular' };\n"
                   + "m.self = m;\n"
                   + "module.exports = { meta: m };";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
    });

    it('reports metaError for a BigInt value inside meta', async function () {
        const m = await report("module.exports = { meta: { name: 'Big', description: 'has a bigint', n: 1n } };");
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
    });

    it('reports metaError for a getter inside meta that throws during serialisation', async function () {
        const code = "module.exports = { meta: { name: 'Boom', get description() { throw new Error('nope'); } } };";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
    });

    it('reports metaError when a toJSON returns undefined (nothing serialises at all)', async function () {
        const m = await report("module.exports = { meta: { toJSON: function () { return undefined; } } };");
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
    });

    it('reports metaOversize and drops the bytes for a meta over the cap', async function () {
        const code = "module.exports = { meta: { name: 'Fat', description: 'x'.repeat(5000) } };";
        const m = await report(code);
        assert.strictEqual(m.metaType, 'object');
        assert.strictEqual(m.metaOversize, true);
        assert.strictEqual(m.metaJson, null, 'oversize bytes must never reach the host');
        assert.strictEqual(m.metaError, false, 'oversize is its own verdict row, not a serialisation error');
    });

    it('admits a meta of exactly the cap (the bound is > , not >=)', async function () {
        // '{"d":"' + value + '"}' is 8 characters of envelope.
        const code = "module.exports = { meta: { d: 'x'.repeat(" + (META_JSON_MAX_CHARS - 8) + ") } };";
        const m = await report(code);
        assert.strictEqual(m.metaOversize, false);
        assert.strictEqual(m.metaError, false);
        assert.strictEqual(m.metaJson.length, META_JSON_MAX_CHARS);
    });

    it('reports a meta far past the report truncation as oversize, not as an unparseable report', async function () {
        // The whole report is truncated host-side at 65536 characters before
        // JSON.parse, so a meta built at runtime would otherwise destroy the report
        // and skip every later check. 200000 characters is well past that.
        const code = "module.exports = { permissions: ['SEND'], meta: { name: 'Huge', description: 'y'.repeat(200000) } };";
        const m = await report(code);
        assert.strictEqual(m.metaOversize, true);
        assert.strictEqual(m.metaJson, null);
        // The rest of the manifest still arrives intact, which is the point.
        assert.deepStrictEqual(m.permissions, ['SEND']);
    });

    it('leaves the EXISTING manifest fields untouched for a permissions-only contract', async function () {
        const code = "module.exports = { permissions: ['SEND','ISSUE'], maxTakeBps: 250, initialize: function () {}, guard: function () {} };";
        const m = await report(code);
        assert.deepStrictEqual(m.permissions, ['SEND', 'ISSUE']);
        assert.strictEqual(m.permissionsType, 'array');
        assert.strictEqual(m.maxTakeBps, 250);
        assert.strictEqual(m.maxTakeBpsType, 'number');
        assert.strictEqual(m.hasInitialize, true);
        assert.strictEqual(m.metaType, 'undefined');
        assert.strictEqual(m.metaJson, null);
        assert.strictEqual(m.metaError, false);
        assert.strictEqual(m.metaOversize, false);
    });

    it('does NOT read meta off a function export for permissions (that verdict must not move)', async function () {
        // __ce stays object-only: a function export's permissions are invisible today
        // and stay invisible, even though its meta is now read.
        const code = "function contract(xchain) { return 'ok'; }\n"
                   + "contract.permissions = ['SEND'];\n"
                   + "contract.maxTakeBps = 250;\n"
                   + "contract.meta = { name: 'Ping', description: 'Returns ok' };\n"
                   + "module.exports = contract;";
        const m = await report(code);
        assert.strictEqual(m.permissions, null);
        assert.strictEqual(m.permissionsType, 'undefined');
        assert.strictEqual(m.maxTakeBps, null);
        assert.strictEqual(m.maxTakeBpsType, 'undefined');
        assert.strictEqual(m.metaType, 'object');
    });

    it('survives a THROWING meta getter without failing the read (permissions verdicts must not move)', async function () {
        // If this escaped the wrapper the manifest would read as absent and the
        // contract's malformed permissions would stop being rejected, below the
        // activation flag as well as above it.
        const code = "module.exports = { permissions: 'SEND', get meta() { throw new Error('nope'); } };";
        const m = await report(code);
        assert.strictEqual(m.permissions, null);
        assert.strictEqual(m.permissionsType, 'string', 'the existing malformed-permissions report must survive');
        assert.strictEqual(m.metaError, true);
        assert.strictEqual(m.metaJson, null);
    });

    it('is deterministic: identical code yields an identical report', async function () {
        const code = "module.exports = { meta: { name: 'Escrow', description: 'Two-party escrow', version: '2.0.0' }, permissions: ['SEND'] };";
        const a = await report(code);
        const b = await report(code);
        assert.deepStrictEqual(a, b);
    });

    it('reads meta under the HARDENED wrapper variant too (derived by the header replace)', async function () {
        // VM_LINT_HARDENING moves the control bindings into IIFE parameters; the
        // manifest body is the same bytes, and this proves it for the meta branch.
        const code = "module.exports = { meta: { name: 'Hard', description: 'hardened wrapper' }, permissions: ['SEND'] };";
        const res = await vm.readManifest(code, {
            network: 'mainnet',
            contractAddress: 'C:BTC:1',
            // At/after VM_LINT_HARDENING_GATE_BLOCK_TIME the hardened wrapper compiles.
            blockContext: { height: 1, timestamp: XChainVM.VM_LINT_HARDENING_GATE_BLOCK_TIME, hash: 'h' }
        });
        assert.strictEqual(res.success, true, 'hardened manifest read must succeed: ' + res.error);
        assert.strictEqual(res.manifest.metaType, 'object');
        assert.strictEqual(res.manifest.metaJson, '{"name":"Hard","description":"hardened wrapper"}');
        assert.deepStrictEqual(res.manifest.permissions, ['SEND']);
    });
});
