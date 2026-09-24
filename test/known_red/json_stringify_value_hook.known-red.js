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
 * KNOWN-RED (re-derivation): does a JSON.stringify value hook let a spine
 * past the F-NR structural-depth guard (src/index.js __guardNativeDepth)?
 *
 * __guardNativeDepth walks only the VALUE ARGUMENT itself -- array elements
 * and own-enumerable-property values, read once, before the native
 * JSON.stringify runs. A spine that the direct walk cannot see, because it
 * is produced by a toJSON() call, substituted by a replacer's return value,
 * or handed back by a getter that answers shallow on the guard's read and
 * deep on the native serializer's later read of the same key, never trips
 * the pre-check. The native call then recurses into the real spine with no
 * guard at all.
 *
 * "direct spine" is the known-good control: the identical spine, with no
 * hook, must trip the deterministic out_of_stack fault. Each "value hook"
 * case asserts that same outcome; a pass means the hook cannot smuggle the
 * spine past the guard, a failure means it can.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
// Use the dedicated hook-gate export when it exists; fall back to the F-NR
// guard's own activation gate (BINARY_ALLOC_GATE_BLOCK_TIME) otherwise, since
// that is what currently arms __guardNativeDepth (__nrGuardOn).
const HOOK_GATE = (XChainVM && typeof XChainVM.JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME === 'number')
    ? XChainVM.JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME
    : GATE;
const DEPTH_LIMIT = (XChainVM && XChainVM.MAX_STACK_DEPTH_MUSL) || 256;

const OUT_OF_STACK = 'out_of_stack: maximum call depth exceeded';

// A plain loop, never recursion, so BUILDING the spine cannot itself trip a
// real JS stack limit: DEPTH_LIMIT + 1 nested single-element arrays, one
// level past the injected __NR_DEPTH_LIMIT.
const SPINE_BUILDER = `
        var spine = [];
        for (var __i = 0; __i < ${DEPTH_LIMIT}; __i++) { spine = [spine]; }
    `;

const blockContext = (t) => ({ height: 100, timestamp: t, hash: 'gate' });

async function run(code, timestamp) {
    const vm = createVM();
    vm.beginBlock();
    const r = await execute(vm, code, { method: 'default', blockContext: blockContext(timestamp) });
    vm.endBlock();
    return r;
}

(XChainVM ? describe : describe.skip)('JSON.stringify value-hook depth bypass (re-derivation)', function () {
    this.timeout(30000);

    describe('direct spine', function () {
        it('passed directly, the spine ends out_of_stack', async function () {
            const code = `module.exports = function(xchain) {
                ${SPINE_BUILDER}
                return JSON.stringify(spine);
            };`;
            const r = await run(code, GATE);
            assert.strictEqual(r.success, false,
                `direct spine must fault, not return; got returnValue=${r.returnValue}`);
            assert.strictEqual(r.error, OUT_OF_STACK,
                `expected the frozen out_of_stack fault, got ${r.error}`);
        });
    });

    describe('value hook', function () {
        it('toJSON: a shallow wrapper whose toJSON() returns the spine', async function () {
            const code = `module.exports = function(xchain) {
                ${SPINE_BUILDER}
                var wrapped = { toJSON: function() { return spine; } };
                return JSON.stringify(wrapped);
            };`;
            const r = await run(code, HOOK_GATE);
            assert.strictEqual(r.success, false,
                `toJSON-hooked spine must fault the same as the direct spine; got returnValue=${r.returnValue}`);
            assert.strictEqual(r.error, OUT_OF_STACK,
                `expected the frozen out_of_stack fault, got ${r.error}`);
        });

        it('replacer: a shallow value whose replacer substitutes the spine', async function () {
            const code = `module.exports = function(xchain) {
                ${SPINE_BUILDER}
                var shallow = { x: 1 };
                function replacer(key, val) { return key === 'x' ? spine : val; }
                return JSON.stringify(shallow, replacer);
            };`;
            const r = await run(code, HOOK_GATE);
            assert.strictEqual(r.success, false,
                `replacer-hooked spine must fault the same as the direct spine; got returnValue=${r.returnValue}`);
            assert.strictEqual(r.error, OUT_OF_STACK,
                `expected the frozen out_of_stack fault, got ${r.error}`);
        });

        it('own getter: shallow on the first read, the spine on the second', async function () {
            const code = `module.exports = function(xchain) {
                ${SPINE_BUILDER}
                var reads = 0;
                var obj = { get x() { reads++; return reads === 1 ? { y: 1 } : spine; } };
                return JSON.stringify(obj);
            };`;
            const r = await run(code, HOOK_GATE);
            assert.strictEqual(r.success, false,
                `getter-hooked spine must fault the same as the direct spine; got returnValue=${r.returnValue}`);
            assert.strictEqual(r.error, OUT_OF_STACK,
                `expected the frozen out_of_stack fault, got ${r.error}`);
        });
    });
});
