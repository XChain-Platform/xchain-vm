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
 * Host-thrown error stack activation
 *
 * An error a gateway function throws on the HOST side used to reach the
 * contract with a non-empty e.stack ("Error: <msg>\n    at (<isolated-vm
 * boundary>)\n    at <isolated-vm>:10:34"). That text is assembled by
 * isolated-vm from the harness position of the wrap() applySync call, so a
 * contract that stores it puts harness line/column bytes and isolated-vm's
 * frame format into hashed state, and any harness edit or isolated-vm bump
 * would fork replay. Errors raised inside the isolate already give "".
 *
 * At/after HOST_ERROR_STACK_STRIP_ACTIVATION the harness rethrows every
 * host-thrown error as a fresh in-isolate error of the same constructor and
 * message, so its stack is "" like any other. Below the activation the legacy
 * text is reproduced byte for byte; the pin below is a replay constraint on
 * harness line 10 and on the isolated-vm version.
 *
 * The armed/legacy pair is regtest vs testnet at a late block: the map is
 * unarmed on testnet and every other testnet gate is armed below the late
 * height, so the two networks differ only in this activation and gasUsed is
 * directly comparable.
 ********************************************************************/
'use strict';

const assert = require('assert');
const { GAS_SCHEDULE, DEFAULT_LIMITS, XChainVM, createVM, execute } = require('../fuzz/helpers/harness.js');

const LATE  = { height: 100000000, timestamp: 4000000000, hash: 'abc123' };
const EARLY = { height: 100, timestamp: 1700000000, hash: 'abc123' };
// The legacy side of every armed/legacy pair runs on testnet just below this
// activation's testnet threshold, or at the late height while testnet is unarmed,
// so arming testnet at a release cut keeps the pair valid. The gas comparison
// also needs every other testnet gate armed below this height.
const TESTNET_THRESHOLD = XChainVM && XChainVM.HOST_ERROR_STACK_STRIP_ACTIVATION
    ? XChainVM.HOST_ERROR_STACK_STRIP_ACTIVATION['BTC:testnet'] : null;
const TESTNET_LEGACY = Number.isFinite(TESTNET_THRESHOLD)
    ? { ...LATE, height: Math.min(LATE.height, TESTNET_THRESHOLD - 1), timestamp: 1792303199 } : LATE;
// The legacy testnet side also sits one second before the v0.24.0 change instant (1792303200),
// so the host-call bounds and per-element meter armed with it leave the wrapper text and gas alone.
const fn = (body) => `module.exports = function(xchain) { ${body} };`;

const LEGACY_STACK = (message) =>
    'Error: ' + message + '\n    at (<isolated-vm boundary>)\n    at <isolated-vm>:10:34';

async function run(code, network, blockContext, overrides) {
    const vm = createVM(overrides);
    vm.beginBlock();
    try {
        const block = blockContext || (network === 'testnet' ? TESTNET_LEGACY : LATE);
        return await execute(vm, code, { method: 'default', network, blockContext: block });
    } finally {
        vm.endBlock();
    }
}

// [id, call that throws on the host, message the contract reads]
const HOST_THROWS = [
    ['plain gateway Error',    `xchain.emit.send(5)`,              'emit params must be an object'],
    ['emit field validation',  `xchain.emit.execute({})`,          'emit: missing required field: contractIndex'],
    ['require revert',         `xchain.require(false, 'nope')`,    '\x03REVERT:nope'],
    ['math revert',            `xchain.math.divide('1', '0')`,     '\x03REVERT:math error: Division by zero'],
];

// Everything a contract can read off the caught error except its stack. The
// stack is probed separately: returning it moves gas with its length, which is
// the intended difference, so only this probe is held to equal gas.
const PROBE = (call) => fn(`try { ${call}; } catch (e) {
    return [e.name, e.message, Object.getOwnPropertyNames(e),
        e instanceof Error, Object.getPrototypeOf(e) === Error.prototype, String(e)]; }`);
const STACK_PROBE = (call) => fn(`try { ${call}; } catch (e) { return String(e.stack); }`);

const suite = XChainVM ? describe : describe.skip;

async function assertArmedMatchesLegacy(call, message) {
    const armedStack  = await run(STACK_PROBE(call), 'regtest');
    const legacyStack = await run(STACK_PROBE(call), 'testnet');
    assert.strictEqual(JSON.parse(armedStack.returnValue), '',
        `host-thrown stack reaches the contract: ${armedStack.returnValue}`);
    assert.strictEqual(JSON.parse(legacyStack.returnValue), LEGACY_STACK(message));

    const armed  = await run(PROBE(call), 'regtest');
    const legacy = await run(PROBE(call), 'testnet');
    assert.strictEqual(armed.success, true, armed.error);
    assert.strictEqual(legacy.success, true, legacy.error);
    // Name, message, own property names, prototype and String(e) are unchanged.
    assert.strictEqual(armed.returnValue, legacy.returnValue);
    assert.strictEqual(JSON.parse(armed.returnValue)[1], message);
    // The rethrow runs in unmetered harness code: no gas moves.
    assert.strictEqual(armed.gasUsed, legacy.gasUsed);
}

suite('host-thrown error stack activation: map', function () {
    it('is frozen, keyed per coin, unarmed on mainnet, and armed on testnet at its v0.24.0 heights', function () {
        const map = XChainVM.HOST_ERROR_STACK_STRIP_ACTIVATION;
        assert.ok(Object.isFrozen(map));
        assert.deepStrictEqual(Object.keys(map), ['BTC:mainnet', 'LTC:mainnet', 'DOGE:mainnet',
            'BTC:testnet', 'LTC:testnet', 'DOGE:testnet']);
        const TESTNET = { 'BTC:testnet': 156908, 'LTC:testnet': 4927400, 'DOGE:testnet': 68005165 };
        for (const key of Object.keys(map)) assert.strictEqual(map[key], TESTNET[key] || null, key);
    });

    it('resolves on regtest from genesis and off everywhere else', function () {
        const isActive = XChainVM.isHostErrorStackStripActive;
        assert.strictEqual(isActive('regtest', 'BTC', 0), true);
        assert.strictEqual(isActive('regtest', null, NaN), true);
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(isActive('mainnet', coin, 1e12), false, `${coin}:mainnet`);
            const at = { BTC: 156908, LTC: 4927400, DOGE: 68005165 }[coin];
            assert.strictEqual(isActive('testnet', coin, at - 1), false, `${coin}:testnet below`);
            assert.strictEqual(isActive('testnet', coin, at), true, `${coin}:testnet at`);
        }
        assert.strictEqual(isActive(undefined, 'BTC', 1e12), false);
        assert.strictEqual(isActive('devnet', 'BTC', 1e12), false);
    });
});

suite('host-thrown error stack activation: armed, caught', function () {
    this.timeout(60000);

    for (const [id, call, message] of HOST_THROWS) {
        it(`${id}: stack is "" and every other observable matches the legacy error`, async function () {
            await assertArmedMatchesLegacy(call, message);
        });
    }

    for (const [label, block] of [['late', LATE], ['early', EARLY]]) {
        it(`${label}: a host-thrown stack stored in state is "" like an in-isolate one`, async function () {
            const r = await run(fn(
                "var h, i; try { xchain.emit.send(5); } catch (e) { h = e.stack; } " +
                "try { null.x; } catch (e) { i = e.stack; } " +
                "xchain.state.set('hostStack', h); xchain.state.set('isoStack', String(i)); return [h, i];"),
            'regtest', block);
            assert.strictEqual(r.success, true, r.error);
            assert.deepStrictEqual(JSON.parse(r.returnValue), ['', '']);
            assert.deepStrictEqual(r.stateChanges, [
                { key: 'hostStack', value: '' },
                { key: 'isoStack', value: '' },
            ]);
        });
    }
});

suite('host-thrown error stack activation: armed, outcomes', function () {
    this.timeout(60000);

    it('uncaught host-thrown errors classify exactly as before', async function () {
        for (const [, call] of HOST_THROWS) {
            const armed  = await run(fn(`${call}; return 1;`), 'regtest');
            const legacy = await run(fn(`${call}; return 1;`), 'testnet');
            assert.strictEqual(armed.success, false);
            assert.deepStrictEqual(
                { error: armed.error, gasUsed: armed.gasUsed, returnValue: armed.returnValue },
                { error: legacy.error, gasUsed: legacy.gasUsed, returnValue: legacy.returnValue });
        }
    });

    it('gas exhaustion inside a gateway call stays uncatchable', async function () {
        const code = fn("var n = 0; for (;;) { try { xchain.state.set('k' + (n++ % 4), 'v'); } catch (e) { n = -1; } } ");
        const armed  = await run(code, 'regtest', LATE, { gasCeiling: 20000 });
        const legacy = await run(code, 'testnet', TESTNET_LEGACY, { gasCeiling: 20000 });
        assert.strictEqual(armed.success, false);
        assert.match(armed.error, /^out_of_gas/);
        assert.deepStrictEqual(
            { error: armed.error, gasUsed: armed.gasUsed },
            { error: legacy.error, gasUsed: legacy.gasUsed });
    });

    it('in-isolate errors are untouched', async function () {
        const code = fn("try { null.x; } catch (e) { return [e.name, String(e.stack)]; }");
        const armed  = await run(code, 'regtest');
        const legacy = await run(code, 'testnet');
        assert.strictEqual(armed.returnValue, legacy.returnValue);
        assert.deepStrictEqual(JSON.parse(armed.returnValue), ['TypeError', '']);
    });
});

suite('host-thrown error stack activation: pre-activation replay', function () {
    this.timeout(60000);

    // Replay constraint: the frame "<isolated-vm>:10:34" is the applySync call
    // in the harness wrap() at line 10, column 34, formatted by isolated-vm.
    // Moving that token, or an isolated-vm release that formats the boundary
    // differently, changes stored state for every pre-activation contract.
    for (const [network, block] of [[undefined, EARLY], ['mainnet', LATE], ['testnet', TESTNET_LEGACY], ['testnet', EARLY]]) {
        it(`${network || 'no network'} at height ${block.height}: legacy stack text byte for byte`, async function () {
            const r = await run(fn("try { xchain.emit.send(5); } catch (e) { xchain.state.set('hostStack', e.stack); return e.stack; }"),
                network, block);
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(JSON.parse(r.returnValue), LEGACY_STACK('emit params must be an object'));
            assert.deepStrictEqual(r.stateChanges,
                [{ key: 'hostStack', value: LEGACY_STACK('emit params must be an object') }]);
        });
    }
});

// The source text of the function wrap() returns for every xchain.* gateway
// method, as develop produces it. A contract reads it through
// Function.prototype.toString and can store it, so below the activation the
// text and the gas of stringifying it are consensus bytes. The '\u0001' is the
// harness's return-value marker, a raw control character in the source.
const LEGACY_WRAP_SOURCE = 'function() {\n' +
    '            var jsonArgs = JSON.stringify(Array.prototype.slice.call(arguments));\n' +
    '            var jsonResult = ref.applySync(undefined, [jsonArgs]);\n' +
    '            if (jsonResult === undefined || jsonResult === null) return jsonResult;\n' +
    "            if (typeof jsonResult === 'string' && jsonResult.charAt(0) === '\u0001') {\n" +
    '                return JSON.parse(jsonResult.substring(1));\n' +
    '            }\n' +
    '            return jsonResult;\n' +
    '        }';

// gasUsed of the stringify-store-return contract below, measured on develop.
// The testnet figure is at the late height; if a cut arms testnet low enough
// that TESTNET_LEGACY drops below another testnet gate, re-measure it there.
const LEGACY_WRAP_SOURCE_GAS = [['mainnet', LATE, 1132], ['mainnet', EARLY, 1129], ['testnet', TESTNET_LEGACY, 1135]];

suite('host-thrown error stack activation: gateway function source text', function () {
    this.timeout(60000);

    for (const name of ['state.get', 'emit.execute', 'math.add']) {
        for (const [network, block, gas] of LEGACY_WRAP_SOURCE_GAS) {
            it(`String(xchain.${name}) on ${network} at height ${block.height} is develop's text and gas`, async function () {
                const r = await run(fn(`var s = String(xchain.${name}); xchain.state.set('src', s); return s;`), network, block);
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(JSON.parse(r.returnValue), LEGACY_WRAP_SOURCE);
                assert.deepStrictEqual(r.stateChanges, [{ key: 'src', value: LEGACY_WRAP_SOURCE }]);
                assert.strictEqual(r.gasUsed, gas);
            });
        }
    }

    it('armed gateway functions still return values and route errors', async function () {
        const r = await run(fn("xchain.state.set('k', 'v'); var m; try { xchain.emit.send(5); } catch (e) { m = e.message; } " +
            "return [xchain.state.get('k'), xchain.math.add('2', '3'), m];"), 'regtest');
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(JSON.parse(r.returnValue), ['v', '5', 'emit params must be an object']);
    });
});

function subprocessOpts(network) {
    return {
        code: fn("var h; try { xchain.emit.send(5); } catch (e) { h = e.stack; } xchain.state.set('hostStack', h); return h;"),
        state: {}, method: 'default', params: [], caller: 'a', contractAddress: 'C:BTC:1',
        contractIndex: 1, txHash: '00'.repeat(32), network,
        blockContext: network === 'testnet' ? TESTNET_LEGACY : LATE,
    };
}

suite('host-thrown error stack activation: subprocess executor', function () {
    this.timeout(60000);
    let sp;
    before(function () {
        sp = new XChainVM({ execution: 'subprocess', gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, limits: DEFAULT_LIMITS });
        sp.beginBlock();
    });
    after(function () {
        try { sp.endBlock(); } catch (e) { /* teardown */ }
        if (sp && sp.shutdown) sp.shutdown();
    });

    it('armed: the stored host-thrown stack is ""', async function () {
        const r = await sp.execute(subprocessOpts('regtest'));
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.stateChanges, [{ key: 'hostStack', value: '' }]);
    });

    it('pre-activation: the stored stack is the legacy text', async function () {
        const r = await sp.execute(subprocessOpts('testnet'));
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(r.stateChanges,
            [{ key: 'hostStack', value: LEGACY_STACK('emit params must be an object') }]);
    });
});
