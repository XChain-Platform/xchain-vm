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
 * Metering constructor wrappers: static surface and prototype chain
 *
 * __meterBinaryCtor (ArrayBuffer / the TypedArrays) and __meterCollectionCtor
 * (Set / Map / WeakSet / WeakMap) replace a global constructor with a closure
 * wrapper that charges the allocation before delegating. The wrapper has to
 * carry the original's identity, and it used to do that by making the ORIGINAL
 * its [[Prototype]] (__setProto(Wrapped, Orig)). Statics then resolved only by
 * inheriting them from the object being replaced, which produced a constructor
 * with a chain no built-in has (getPrototypeOf(Uint8Array) !== getPrototypeOf(
 * Int8Array)) and with ZERO own statics, so BYTES_PER_ELEMENT / isView /
 * Symbol.species were invisible to getOwnPropertyNames / getOwnPropertySymbols,
 * and any wrapper that failed to reach the original lost the whole surface.
 *
 * The wrappers now inherit from what the ORIGINAL inherits from and copy the
 * original's own statics across by descriptor, while deliberately NOT copying
 * name, length or prototype: the wrapper already owns all three, all three are
 * readable from contract code, and prototype is the alias that keeps instanceof
 * working. This fixture pins both halves, so an edit that reinstates the
 * inherit-from-the-original shape, drops a static, or starts copying the three
 * skipped keys reddens here.
 *
 * Gas is untouched by any of this (property READS resolve to the same values
 * either way), so there is no flag day: the charge assertions below are the
 * guard on that.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;

// At the flag day the binary constructors are wrapped; one second below it they
// are the untouched natives, which is what the "unwrapped" contrast asserts.
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };
const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };

// Collection-constructor metering rides the per-coin Pkg 3 HEIGHT gate, which is
// active from genesis on regtest/testnet, so the network is what arms it here.
const REGTEST = 'regtest';

(XChainVM ? describe : describe.skip)('metering constructor wrappers: statics + prototype chain (regression)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    // Runs `expr` (a contract-source expression) inside the isolate and returns
    // its string value, failing the test with the VM error when it did not run.
    async function evalIn(expr, extraOpts) {
        const code = 'module.exports = function(){ return String(' + expr + '); };';
        const r = await execute(vm, code, Object.assign({ method: 'default', blockContext: AT }, extraOpts || {}));
        assert.strictEqual(r.success, true, 'contract failed: ' + r.error);
        // returnValue is JSON-encoded by the gateway.
        return JSON.parse(r.returnValue);
    }

    describe('binary constructors (__meterBinaryCtor)', function () {
        it('the original OWN statics are own properties of the wrapper, with the original values', async function () {
            assert.strictEqual(await evalIn('Uint8Array.BYTES_PER_ELEMENT'), '1');
            assert.strictEqual(await evalIn('Float64Array.BYTES_PER_ELEMENT'), '8');
            assert.strictEqual(
                await evalIn("Object.getOwnPropertyNames(Uint8Array).indexOf('BYTES_PER_ELEMENT') >= 0"), 'true',
                'BYTES_PER_ELEMENT must be an OWN property of the wrapper, not inherited from the constructor it replaced');
            assert.strictEqual(
                await evalIn("Object.getOwnPropertyNames(ArrayBuffer).indexOf('isView') >= 0"), 'true');
            assert.strictEqual(await evalIn('typeof ArrayBuffer.isView'), 'function');
            assert.strictEqual(await evalIn('ArrayBuffer.isView(new Uint8Array(1))'), 'true');
        });

        it('Symbol-keyed statics are carried across by descriptor', async function () {
            assert.strictEqual(
                await evalIn('Object.getOwnPropertySymbols(ArrayBuffer).indexOf(Symbol.species) >= 0'), 'true');
            // The species getter returns `this`, so through the wrapper it must
            // name the wrapper (a derived buffer stays metered).
            assert.strictEqual(await evalIn('ArrayBuffer[Symbol.species] === ArrayBuffer'), 'true');
        });

        it('the wrapper inherits from what the ORIGINAL inherits from, so inherited statics still resolve', async function () {
            // Every typed-array constructor shares one %TypedArray% intrinsic. The
            // old shape made each wrapper inherit from its own original instead,
            // so this comparison was false.
            assert.strictEqual(
                await evalIn('Object.getPrototypeOf(Uint8Array) === Object.getPrototypeOf(Int8Array)'), 'true');
            assert.strictEqual(
                await evalIn('Object.getPrototypeOf(Uint8Array) === Object.getPrototypeOf(Float64Array)'), 'true');
            // from/of live on %TypedArray%, i.e. they are reachable ONLY through
            // that chain, and they construct through the wrapper.
            assert.strictEqual(await evalIn('typeof Uint8Array.from'), 'function');
            assert.strictEqual(await evalIn('typeof Uint8Array.of'), 'function');
            assert.strictEqual(await evalIn('Uint8Array.from([1, 2, 3]).length'), '3');
            assert.strictEqual(await evalIn('Uint8Array.of(1, 2).length'), '2');
            // The wrapper must NOT be standing behind the constructor it replaced.
            assert.strictEqual(
                await evalIn('Object.getPrototypeOf(Uint8Array) === Object.getPrototypeOf(ArrayBuffer)'), 'false');
        });

        it('name, length and prototype keep the WRAPPER\'s own values (never copied from the original)', async function () {
            // These three are read by contract code, so copying the original's
            // descriptors over them would move an observable value for no gain.
            // Pinned literally: an edit that starts copying them reddens here.
            assert.strictEqual(await evalIn('Uint8Array.name'), 'Wrapped');
            assert.strictEqual(await evalIn('Uint8Array.length'), '1');
            assert.strictEqual(await evalIn('ArrayBuffer.name'), 'Wrapped');
            assert.strictEqual(await evalIn('ArrayBuffer.length'), '1');
            // prototype is the instanceof-preserving alias, not the original's
            // own `prototype` descriptor re-defined onto the wrapper.
            assert.strictEqual(
                await evalIn('Uint8Array.prototype === Object.getPrototypeOf(new Uint8Array(1))'), 'true');
        });

        it('instanceof and instance.constructor still route through the wrapper', async function () {
            assert.strictEqual(await evalIn('(new Uint8Array(2)) instanceof Uint8Array'), 'true');
            assert.strictEqual(await evalIn('(new Float64Array(2)) instanceof Float64Array'), 'true');
            assert.strictEqual(await evalIn('(new ArrayBuffer(8)) instanceof ArrayBuffer'), 'true');
            assert.strictEqual(await evalIn('(new Uint8Array(2)).constructor === Uint8Array'), 'true');
        });

        it('below the flag day the constructors are the untouched natives', async function () {
            // The contrast that proves the assertions above describe the WRAPPER
            // and not the built-in: unwrapped, the name is the real one.
            assert.strictEqual(await evalIn('Uint8Array.name', { blockContext: BEFORE }), 'Uint8Array');
            assert.strictEqual(await evalIn('Uint8Array.BYTES_PER_ELEMENT', { blockContext: BEFORE }), '1');
        });

        it('the byte-length charge is unchanged by the static/chain repair', async function () {
            // Gas is the consensus-visible half of these wrappers. Property reads
            // resolve to the same values before and after the repair, so the
            // charge must be exactly the byte count it always was.
            const code = 'module.exports = function(){ var a = new Uint8Array(50000); return a.length; };';
            const r = await execute(vm, code, { method: 'default', blockContext: AT });
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(r.returnValue, '50000');
            assert.ok(r.gasUsed >= 50000, 'byte charge must still land, got ' + r.gasUsed);
            assert.ok(r.gasUsed < 50100, 'no NEW charge may have appeared, got ' + r.gasUsed);
        });
    });

    describe('collection constructors (__meterCollectionCtor)', function () {
        const OPTS = { blockContext: AT, network: REGTEST };

        it('Symbol-keyed statics are carried across, and species names the wrapper', async function () {
            assert.strictEqual(
                await evalIn('Object.getOwnPropertySymbols(Set).indexOf(Symbol.species) >= 0', OPTS), 'true');
            assert.strictEqual(await evalIn('Set[Symbol.species] === Set', OPTS), 'true');
            assert.strictEqual(await evalIn('Map[Symbol.species] === Map', OPTS), 'true');
        });

        it('the wrappers share one [[Prototype]] again instead of each standing behind its own original', async function () {
            // Set and Map both inherit from Function.prototype. The old shape gave
            // each wrapper its own original as [[Prototype]], so they differed.
            // (Function itself is neutered in the sandbox, so the intrinsic is
            // compared through two constructors rather than named directly.)
            assert.strictEqual(
                await evalIn('Object.getPrototypeOf(Set) === Object.getPrototypeOf(Map)', OPTS), 'true');
            assert.strictEqual(
                await evalIn('Object.getPrototypeOf(WeakSet) === Object.getPrototypeOf(WeakMap)', OPTS), 'true');
            assert.strictEqual(await evalIn('Object.getPrototypeOf(Set) === Set', OPTS), 'false');
        });

        it('name, length and prototype keep the WRAPPER\'s own values', async function () {
            assert.strictEqual(await evalIn('Set.name', OPTS), 'Wrapped');
            assert.strictEqual(await evalIn('Set.length', OPTS), '1');
            assert.strictEqual(await evalIn('Map.name', OPTS), 'Wrapped');
            assert.strictEqual(
                await evalIn('Set.prototype === Object.getPrototypeOf(new Set())', OPTS), 'true');
        });

        it('instanceof, constructor and construction still work through the wrappers', async function () {
            assert.strictEqual(await evalIn('(new Set([1, 2, 3])) instanceof Set', OPTS), 'true');
            assert.strictEqual(await evalIn('(new Map([[1, 2]])) instanceof Map', OPTS), 'true');
            assert.strictEqual(await evalIn('(new WeakSet()) instanceof WeakSet', OPTS), 'true');
            assert.strictEqual(await evalIn('(new WeakMap()) instanceof WeakMap', OPTS), 'true');
            assert.strictEqual(await evalIn('(new Set()).constructor === Set', OPTS), 'true');
            assert.strictEqual(await evalIn('new Set([1, 2, 3]).size', OPTS), '3');
            assert.strictEqual(await evalIn('new Map([[1, 2]]).size', OPTS), '1');
        });

        it('the source-size charge is unchanged by the static/chain repair', async function () {
            const code = 'module.exports = function(){ var a = []; for (var i = 0; i < 500; i++) a.push(i); ' +
                'var s = new Set(a); return s.size; };';
            const r = await execute(vm, code, { method: 'default', blockContext: AT, network: REGTEST });
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(r.returnValue, '500');
            assert.ok(r.gasUsed >= 500, 'the 500-element source charge must still land, got ' + r.gasUsed);
        });
    });
});
