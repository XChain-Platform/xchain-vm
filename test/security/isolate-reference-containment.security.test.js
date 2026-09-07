/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Isolate/host boundary: no guest-reachable ivm.Reference.
 *
 * The host injects ivm.Reference objects (the gas hook and every gateway
 * bridge) and the harness captures each into a closure before deleting its
 * global. A guest that reaches ONE of them reaches the ExternalCopy
 * constructor through it, and an isolated-vm binding at or below 7.0.0 lets
 * that constructor be driven into a transferList type confusion: an index
 * getter answers ArrayBuffer to the validating walk and an integer to the
 * unchecked cast, which then dereferences an attacker-chosen address. On a
 * validator that is host memory corruption reached from contract code, so the
 * boundary is asserted two ways: nothing a contract can hold carries Reference
 * methods, and the installed binding is outside the affected range.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const IVM_VERSION = require('isolated-vm/package.json').version;

// The methods that mark a value as a live cross-boundary handle rather than a
// plain harness function.
const REFERENCE_METHODS = ['getSync', 'applySync', 'derefInto', 'copySync'];

/** [major, minor, patch] of a plain release version, ignoring any prerelease tag. */
function parts(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    assert.ok(m, `isolated-vm version "${version}" is not a plain release version`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `version` is at or above `floor`, both as [major, minor, patch]. */
function atLeast(version, floor) {
    const actual = parts(version);
    for (let i = 0; i < 3; i++) if (actual[i] !== floor[i]) return actual[i] > floor[i];
    return true;
}

/**
 * True while the installed binding carries the ExternalCopy transferList type
 * confusion. Upstream patched two lines rather than one: 6.2.0 backports the
 * fix onto 6.x, 7.0.1 carries it forward. Everything else at or below 7.0.0 is
 * affected.
 */
function affectedByTransferListConfusion(version) {
    const [major] = parts(version);
    if (major >= 8) return false;
    if (major === 7) return !atLeast(version, [7, 0, 1]);
    if (major === 6) return !atLeast(version, [6, 2, 0]);
    return true;
}

// The advisory's minimal guest-reachable crash. Runs in a child process so a
// regression reports as a killed process instead of taking the suite with it.
const CONFUSION_PROBE = `
    const ivm = require('isolated-vm');
    const isolate = new ivm.Isolate();
    const context = isolate.createContextSync();
    context.global.setSync('ref', new ivm.Reference({ x: 1 }));
    try {
        context.evalSync(\`
            const ExternalCopy = ref.getSync('x', { externalCopy: true }).constructor;
            const real = new ArrayBuffer(8);
            let reads = 0;
            const transferList = [];
            Object.defineProperty(transferList, 0, {
                enumerable: true,
                get() { return ++reads === 1 ? real : 0x41414141; }
            });
            new ExternalCopy({}, { transferList });
        \`);
    } catch (e) {
        // Rejecting the second walk is the patched behaviour.
    }
    process.exit(0);
`;

// Contract source that walks everything a contract can still hold and reports
// any value carrying cross-boundary methods. Written as a string because it
// runs inside the isolate, under the deploy-time syntax rules.
const SWEEP_SOURCE = `
exports.default = function () {
    var methods = ${JSON.stringify(REFERENCE_METHODS)};
    var found = [];
    var carries = function (label, value) {
        if (value === null) return;
        var t = typeof value;
        if (t !== 'object' && t !== 'function') return;
        for (var i = 0; i < methods.length; i++) {
            if (typeof value[methods[i]] === 'function') { found.push(label + '.' + methods[i]); }
        }
    };
    var names = Object.getOwnPropertyNames(globalThis);
    for (var n = 0; n < names.length; n++) {
        carries('globalThis.' + names[n], globalThis[names[n]]);
    }
    var keys = Object.keys(xchain);
    for (var k = 0; k < keys.length; k++) {
        var member = xchain[keys[k]];
        carries('xchain.' + keys[k], member);
        if (member !== null && typeof member === 'object') {
            var subKeys = Object.keys(member);
            for (var s = 0; s < subKeys.length; s++) {
                carries('xchain.' + keys[k] + '.' + subKeys[s], member[subKeys[s]]);
            }
        }
        if (typeof member === 'function') {
            carries('proto(xchain.' + keys[k] + ')', Object.getPrototypeOf(member));
        }
    }
    return found.join(',');
};
`;

(XChainVM ? describe : describe.skip)('isolate/host boundary: ivm.Reference containment', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('installs an isolated-vm outside the ExternalCopy transferList advisory', function () {
        assert.strictEqual(affectedByTransferListConfusion(IVM_VERSION), false,
            `isolated-vm ${IVM_VERSION} carries the ExternalCopy transferList type confusion, so a ` +
            'guest holding one Reference can corrupt host memory. Move to 6.2.0 or 7.0.1.');
    });

    it('survives a transferList index getter that answers differently on each walk', function () {
        const child = spawnSync(process.execPath, ['-e', CONFUSION_PROBE], {
            cwd: path.resolve(__dirname, '..', '..'),
            encoding: 'utf8',
            timeout: 20000
        });
        assert.strictEqual(child.signal, null,
            `the ExternalCopy transferList walk killed the host with ${child.signal}: isolated-vm ` +
            `${IVM_VERSION} lets guest-reachable code corrupt host memory`);
        assert.strictEqual(child.status, 0,
            `the transferList probe exited ${child.status}: ${(child.stderr || '').slice(0, 400)}`);
    });

    it('leaves no value a contract can hold carrying cross-boundary methods', async function () {
        const result = await execute(vm, SWEEP_SOURCE, { method: 'default' });
        assert.strictEqual(result.success, true, `sweep failed: ${result.error}`);
        assert.strictEqual(result.returnValue, '""',
            `contract code reached live Reference methods: ${result.returnValue}`);
    });

    it('exposes the gas hook as a plain function, not the Reference behind it', async function () {
        const result = await execute(vm,
            'exports.default = function () { return typeof __gas + ":" + typeof __gas.applySync; };',
            { method: 'default' });
        assert.strictEqual(result.success, true, `gas-hook probe failed: ${result.error}`);
        assert.strictEqual(result.returnValue, '"function:undefined"',
            `the gas hook surfaced ${result.returnValue} instead of a plain function`);
    });
});
