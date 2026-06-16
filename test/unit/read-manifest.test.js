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
// readManifest() — Phase E permissions-manifest introspection.
//
// Surfaces a contract's exported `permissions` + `maxTakeBps` at deploy time by
// instantiating the module top-level (no method dispatch), so it works even for
// constructor-less contracts. Type tags are reported (not just values) so the
// indexer can fail-closed on a malformed manifest. The VM only reports faithfully;
// all validation lives host-side (indexer actions/deploy.js).

const assert = require('assert');

// Requires isolated-vm. Skip if unavailable (e.g. Node != 22). Mirrors sibling tests.
let XChainVM;
try {
    XChainVM = require('../../src/index.js');
} catch (e) {
    console.log('Skipping read-manifest tests — isolated-vm not available:', e);
}

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

(XChainVM ? describe : describe.skip)('readManifest (Phase E)', function () {

    let vm;
    before(function () { vm = createVM(); });

    it('surfaces a declared permissions array + maxTakeBps', async function () {
        const code = "module.exports = { permissions: ['SEND','ISSUE'], maxTakeBps: 250, guard: function(){} };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.manifest.permissions, ['SEND', 'ISSUE']);
        assert.strictEqual(res.manifest.permissionsType, 'array');
        assert.strictEqual(res.manifest.maxTakeBps, 250);
        assert.strictEqual(res.manifest.maxTakeBpsType, 'number');
    });

    it('reports BARE contracts (no manifest exports) as undefined-typed, not as a restriction', async function () {
        const code = "module.exports = { guard: function(){} };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.manifest.permissions, null);
        assert.strictEqual(res.manifest.permissionsType, 'undefined');
        assert.strictEqual(res.manifest.maxTakeBps, null);
        assert.strictEqual(res.manifest.maxTakeBpsType, 'undefined');
    });

    it('works for a constructor-less contract (vm.execute never runs it otherwise)', async function () {
        // No `initialize` export — the indexer would never have executed this at deploy,
        // yet the manifest is still surfaced because readManifest only needs module top-level.
        const code = "module.exports = { permissions: [], maxTakeBps: 0 };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.manifest.permissions, []);  // explicit empty = emits nothing
        assert.strictEqual(res.manifest.maxTakeBps, 0);
    });

    it('reports a MALFORMED permissions export with its real type (host rejects)', async function () {
        // permissions as a string is invalid; the VM must surface the type so the indexer
        // can fail-closed rather than silently treat it as absent/unrestricted.
        const code = "module.exports = { permissions: 'SEND' };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.manifest.permissions, null);
        assert.strictEqual(res.manifest.permissionsType, 'string');
    });

    it('reports a non-integer maxTakeBps with its real type (host rejects)', async function () {
        const code = "module.exports = { maxTakeBps: 2.5 };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        // 2.5 is a number — surfaced as-is; the indexer rejects non-integers.
        assert.strictEqual(res.manifest.maxTakeBps, 2.5);
        assert.strictEqual(res.manifest.maxTakeBpsType, 'number');
    });

    it('is deterministic — identical code yields an identical manifest', async function () {
        const code = "module.exports = { permissions: ['SEND'], maxTakeBps: 100, guard: function(){} };";
        const a = await vm.readManifest(code);
        const b = await vm.readManifest(code);
        assert.deepStrictEqual(a.manifest, b.manifest);
    });

    it('does NOT dispatch a method (a throwing guard does not affect the read)', async function () {
        const code = "module.exports = { permissions: ['SEND'], guard: function(){ throw new Error('should not run'); } };";
        const res = await vm.readManifest(code);
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.manifest.permissions, ['SEND']);
    });
});
