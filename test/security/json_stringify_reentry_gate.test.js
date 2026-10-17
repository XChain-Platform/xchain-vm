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
 * Security regression: JSON.stringify on the value-hook path is re-entrant
 * once the re-entry activation is armed.
 *
 * The value-hook walk keeps its frames in one pool and hands the native call
 * one forwarded key list, both shared by every call. A toJSON method, a
 * replacer function or a getter that calls JSON.stringify itself overwrote
 * both, so the OUTER call returned the INNER call's result. Armed (regtest),
 * every shape below must equal the native answer mainnet gives. Unarmed
 * (testnet, where the value-hook path is on), output, gasUsed and the
 * wrapper's own source text must stay exactly what they were before the fix.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

// Past the testnet value-hook flag day, so testnet runs the value-hook path
// with the re-entry activation unarmed.
const LATE = { height: 200000, timestamp: 4000000000, hash: 'reentry' };
// The v0.24.0 cut arms testnet at BTC 156908 (LTC and DOGE higher) and at block time 1792303200;
// testnet probes run just below both, where every earlier testnet gate is already armed.
const PRE_ARM_TESTNET = { height: 156907, timestamp: 1792303199 };
const contextFor = (network) => (network === 'testnet' ? { ...LATE, ...PRE_ARM_TESTNET } : LATE);
const ADDRESS = 'C:BTC:7';

async function run(body, network, gasCeiling) {
    const vm = createVM(gasCeiling ? { gasCeiling } : undefined);
    vm.beginBlock();
    const code = 'module.exports = function(xchain) { ' + body + ' };';
    const r = await execute(vm, code, { network, contractAddress: ADDRESS, blockContext: contextFor(network) });
    vm.endBlock();
    return r;
}

// Each shape with the output and gasUsed the unarmed path produced before the
// fix: the broken inner-result answers are the pre-activation behaviour, and
// they must replay byte for byte.
const SHAPES = {
    'nested call inside toJSON': {
        body: 'var o = { toJSON: function () { JSON.stringify({ q: [1, 2, 3] }); return 5; } };' +
            ' return JSON.stringify({ a: { b: o, c: 2 }, d: [7, 8] });',
        legacy: ['{"q":[1,2,3]}', 128],
    },
    'nested call inside a replacer function': {
        body: 'return JSON.stringify({ a: { b: 1, c: 2 }, d: [7, 8] }, function (k, v) {' +
            ' if (k === "b") JSON.stringify({ z: [9, 9] }); return v; });',
        legacy: ['{"z":[9,9]}', 192],
    },
    'nested call inside a getter': {
        body: 'var o = { c: 3, get g() { JSON.stringify({ x: { y: 1 } }); return 4; } };' +
            ' return JSON.stringify({ a: { o: o, t: 1 }, d: [2] });',
        legacy: ['{"x":{"y":1,"o":{"c":3,"g":4}}}', 203],
    },
    'nested two levels deep': {
        body: 'var log = [];' +
            ' var inner = { toJSON: function () { log.push(JSON.stringify({ deep: [1, { e: 2 }] })); return "i"; } };' +
            ' var mid = { toJSON: function () { log.push(JSON.stringify({ m: [inner, 3], n: { p: 4 } })); return "m"; } };' +
            ' return JSON.stringify({ a: { b: mid, c: [5, 6] }, d: 7 }) + "|" + log.join("|");',
        legacy: ['{"deep":["i",{"e":2}]}|{"deep":[1,{"e":2}]}|{"deep":["i",{"e":2}]}', 294],
    },
    'nested call under an outer replacer array': {
        body: 'var o = { toJSON: function () { JSON.stringify({ x: 1, y: 2 }); return 5; } };' +
            ' return JSON.stringify({ a: { b: o, x: 1 }, k: { a: 1, x: 2 } }, ["a", "b", "k"]);',
        legacy: ['{"x":1,"y":2,"a":{"b":5}}', 161],
    },
};

// The value guard has no cycle check: a cycle walks to the depth limit and takes
// the un-catchable out_of_stack fault on every network. Nested inside toJSON it
// must end the same way, armed or not.
const CYCLE_INSIDE_INNER = 'var o = { toJSON: function () { var c = { k: 1 }; c.self = c;' +
    ' try { JSON.stringify({ w: c }); } catch (e) { return "caught"; } return "none"; } };' +
    ' return JSON.stringify({ a: { b: o, c: 2 }, d: [7, 8] });';
const OUT_OF_STACK = 'out_of_stack: maximum call depth exceeded';
// Where the host-call bounds activation is armed too, the value-hook walk detects the
// cycle and throws a catchable TypeError, inside the nested call as at the top level,
// so the toJSON catches it and the outer call completes.
const CYCLE_CAUGHT = JSON.stringify(JSON.stringify({ a: { b: 'caught', c: 2 }, d: [7, 8] }));

// sha256 of String(JSON.stringify) on the unarmed path, measured on the tree
// before the fix. Contract code can read this text and store it, so it is
// consensus-visible and must not move while the activation is unarmed.
const LEGACY_WRAPPER_SHA256 = 'c2beaf473218b2fe6dfcbac4aca813c0419b627b3984cc6aebb235ac0fb3051a';
const LEGACY_WRAPPER_LENGTH = 1096;

function registerDerivationTests() {
    describe('armed harness derivation', function () {
        it('edits three existing lines in place and only adds lines before the closing line', function () {
            const { HARNESS_SOURCE } = require('../../src/index/runtime/harness_source.js');
            const { HARNESS_SOURCE_STRINGIFY_REENTRY } = require('../../src/index/armed_harness/json_stringify_reentry.js');
            const base = HARNESS_SOURCE.split('\n');
            const armed = HARNESS_SOURCE_STRINGIFY_REENTRY.split('\n');
            const closing = base.length - 2;
            assert.strictEqual(base[closing], '})();');
            assert.strictEqual(armed[armed.length - 2], '})();');
            const edited = [];
            for (let i = 0; i < closing; i++) if (base[i] !== armed[i]) edited.push(i);
            assert.strictEqual(edited.length, 3, 'edited lines: ' + edited.map((i) => i + 1));
            // Stripping the inserted fragments gives back each original line exactly.
            const restore = (t) => t.replace(/ if \(__jsonHookGuardOn\) \{ .*\}$/, '')
                .replace('__rsfNewFrame({', '{').replace('pKey: null });', 'pKey: null };');
            for (const i of edited) assert.strictEqual(restore(armed[i]), base[i], 'line ' + (i + 1));
        });
    });
}

function registerMapTests() {
    describe('activation map', function () {
        it('is unarmed on mainnet, armed on testnet at its v0.24.0 heights, and active on regtest', function () {
            const map = XChainVM.JSON_STRINGIFY_REENTRY_ACTIVATION;
            const isActive = XChainVM.isJsonStringifyReentryActive;
            assert.ok(Object.isFrozen(map));
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                const armedAt = { BTC: 156908, LTC: 4927400, DOGE: 68005165 }[coin];
                assert.strictEqual(map[coin + ':mainnet'], null);
                assert.strictEqual(isActive('mainnet', coin, 1e9), false, coin + ':mainnet');
                assert.strictEqual(map[coin + ':testnet'], armedAt);
                assert.strictEqual(isActive('testnet', coin, armedAt - 1), false, coin + ':testnet below');
                assert.strictEqual(isActive('testnet', coin, armedAt), true, coin + ':testnet at');
            }
            assert.strictEqual(isActive('regtest', 'BTC', 0), true);
            assert.strictEqual(isActive('regtest', null, NaN), true);
            assert.strictEqual(isActive('devnet', 'BTC', 1e9), false);
        });
    });
}

function registerShapeTests() {
    for (const [name, shape] of Object.entries(SHAPES)) {
        describe(name, function () {
            it('armed, returns the native answer', async function () {
                const native = await run(shape.body, 'mainnet');
                const armed = await run(shape.body, 'regtest');
                assert.strictEqual(native.success, true, String(native.error));
                assert.strictEqual(armed.success, true, String(armed.error));
                assert.strictEqual(armed.returnValue, native.returnValue);
            });

            it('unarmed, replays the pre-activation output and gas', async function () {
                const r = await run(shape.body, 'testnet');
                assert.strictEqual(r.success, true, String(r.error));
                assert.strictEqual(JSON.parse(r.returnValue), shape.legacy[0]);
                assert.strictEqual(r.gasUsed, shape.legacy[1]);
            });
        });
    }
}

function registerCycleTests() {
    describe('a cycle inside the inner call', function () {
        for (const network of ['regtest', 'testnet', 'mainnet']) {
            const cycleCaught = XChainVM && XChainVM.isHostCallBoundsActive(network, contextFor(network).timestamp);
            it(network + (cycleCaught ? ' catches the cycle the host-call bounds rule detects'
                : ' takes the out_of_stack fault'), async function () {
                const r = await run(CYCLE_INSIDE_INNER, network);
                if (cycleCaught) {
                    assert.strictEqual(r.success, true, r.error);
                    assert.strictEqual(r.returnValue, CYCLE_CAUGHT);
                    return;
                }
                assert.strictEqual(r.success, false);
                assert.strictEqual(r.error, OUT_OF_STACK);
            });
        }
    });
}

function registerWrapperTextTests() {
    describe('wrapper source text', function () {
        const body = 'return String(JSON.stringify) + "|" + JSON.stringify.length;';
        for (const network of ['mainnet', 'testnet']) {
            it(network + ' keeps the pre-activation wrapper byte for byte', async function () {
                const r = await run(body, network);
                const text = JSON.parse(r.returnValue);
                assert.strictEqual(text.length, LEGACY_WRAPPER_LENGTH);
                assert.strictEqual(crypto.createHash('sha256').update(text).digest('hex'),
                    LEGACY_WRAPPER_SHA256);
            });
        }

        it('regtest installs the re-entrant wrapper with the same arity', async function () {
            const r = await run(body, 'regtest');
            const text = JSON.parse(r.returnValue);
            assert.ok(text.endsWith('|1'), text.slice(-4));
            assert.notStrictEqual(crypto.createHash('sha256').update(text).digest('hex'),
                LEGACY_WRAPPER_SHA256);
        });
    });
}

function registerGasTests() {
    describe('gas', function () {
        it('a call that nests nothing costs the same armed and unarmed', async function () {
            const body = 'var o = { toJSON: function () { return { r: [1, 2] }; } };' +
                ' return JSON.stringify({ a: { b: o, c: 2 }, d: [7, 8] }, null, 2);';
            const armed = await run(body, 'regtest');
            const unarmed = await run(body, 'testnet');
            assert.strictEqual(armed.success, true, String(armed.error));
            assert.strictEqual(armed.returnValue, unarmed.returnValue);
            assert.strictEqual(armed.gasUsed, unarmed.gasUsed);
        });

        // 200 nesting levels, each walking a 250-deep spine in its own pool: every
        // nested pool frame is charged, so the gas ceiling binds deterministically
        // long before the pools could press on the isolate memory limit.
        const DEEP = 'var spine = []; for (var i = 0; i < 250; i++) spine = [spine]; var n = 0;' +
            ' var o = { toJSON: function () { n++; if (n < 200) JSON.stringify([spine, o]); return n; } };' +
            ' return JSON.stringify(o) + ":" + n;';

        it('deep re-entry under a tight ceiling ends out_of_gas, identically each run', async function () {
            const a = await run(DEEP, 'regtest', 1000000);
            const b = await run(DEEP, 'regtest', 1000000);
            assert.strictEqual(a.success, false);
            assert.ok(/^out_of_gas/.test(a.error), String(a.error));
            assert.strictEqual(a.error, b.error);
            assert.strictEqual(a.gasUsed, b.gasUsed);
        });

        it('deep re-entry under a wide ceiling completes with a fixed, charged gasUsed', async function () {
            const a = await run(DEEP, 'regtest', 20000000);
            const b = await run(DEEP, 'regtest', 20000000);
            const unarmed = await run(DEEP, 'testnet', 20000000);
            assert.strictEqual(a.success, true, String(a.error));
            assert.strictEqual(JSON.parse(a.returnValue), '200:200');
            assert.strictEqual(a.gasUsed, b.gasUsed);
            assert.ok(a.gasUsed > unarmed.gasUsed, a.gasUsed + ' vs ' + unarmed.gasUsed);
        });

        it('a toJSON that re-enters without end takes the out_of_stack fault', async function () {
            const body = 'var o = { toJSON: function () { return JSON.stringify([o, 1]); } }; return JSON.stringify(o);';
            const r = await run(body, 'regtest');
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.error, OUT_OF_STACK);
        });
    });
}

describe('security: re-entrant JSON.stringify on the value-hook path', function () {
    this.timeout(60000);

    before(function () {
        if (!XChainVM) this.skip();
    });

    registerDerivationTests();
    registerMapTests();
    registerShapeTests();
    registerCycleTests();
    registerWrapperTextTests();
    registerGasTests();
});
