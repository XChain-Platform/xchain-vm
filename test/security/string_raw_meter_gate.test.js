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
 * Direct String.raw result-length metering gate.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const nodeVM = require('vm');
const runtime = require('../../src/index.js');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');
const harnessPart5 = require('../../src/index/runtime/harness_part_5.js');

const K = 100000;
const WALL_MS = 30000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

function stringRawHarnessFragment() {
    const start = harnessPart5.indexOf('        var __stringRaw = String.raw;');
    const end = harnessPart5.indexOf('        // resize/transfer', start);
    assert.ok(start >= 0 && end > start, 'String.raw harness fragment');
    return harnessPart5.slice(start, end);
}

describe('direct String.raw result-length wrapper', function () {
    it('charges the exact result length without relying on metered string construction', function () {
        const large = 'x'.repeat(K);
        const context = nodeVM.createContext({ large });
        const source = `
            var charged = 0, __perElemMeterOn = false;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${stringRawHarnessFragment()}
            var result = String.raw({raw:['a','b']}, large);
            var measured = [charged, result.length, result];`;
        nodeVM.runInContext(source, context);
        assert.deepStrictEqual(Array.from(context.measured), [K + 2, K + 2, `a${large}b`]);
    });

    it('preserves native coercion counts, return value and thrown errors', function () {
        const context = nodeVM.createContext({});
        const source = `
            var charged = 0, __perElemMeterOn = false;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${stringRawHarnessFragment()}
            var rawCalls=0,subCalls=0;
            var template={raw:{length:2,0:{toString:function(){rawCalls++;return 'a';}},1:'b'}};
            var sub={toString:function(){subCalls++;return 'x';}};
            var value=String.raw(template,sub);
            var errorName='';
            try { String.raw(null); } catch (e) { errorName=e.name; }
            var measured=[value,rawCalls,subCalls,charged,errorName];`;
        nodeVM.runInContext(source, context);
        assert.deepStrictEqual(Array.from(context.measured), ['axb', 1, 1, 3, 'TypeError']);
    });
});

// Legacy gas of one body on mainnet, pre-arm testnet, no network and an unknown one.
async function legacyGas(run, body) {
    const gas = {};
    const early = { ...LATE, timestamp: runtime.APPLY_LENGTH_METER_ACTIVATION.testnet - 1 };
    for (const network of ['mainnet', 'testnet', undefined, 'unknown']) {
        const extra = network === 'testnet' ? { blockContext: early } : undefined;
        const result = await run(body, network, extra);
        assert.strictEqual(result.success, true, `${network}: ${result.error}`);
        gas[String(network)] = result.gasUsed;
    }
    return gas;
}

// Regtest also arms the per-element meter, which adds a per-segment String.raw charge
// testnet does not apply yet; run regtest with that gate held off.
async function runRegtestWithoutPerElement(run, body) {
    const perElement = require('../../src/index/per_element_meter.js').PER_ELEMENT_METER_ACTIVATION;
    const saved = perElement.regtest;
    perElement.regtest = null;
    try { return await run(body, 'regtest', { gasCeiling: undefined }); }
    finally { perElement.regtest = saved; }
}

(XChainVM ? describe : describe.skip)('direct String.raw metering gate', function () {
    this.timeout(120000);
    let vm;
    beforeEach(function () {
        vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: WALL_MS });
        vm.beginBlock();
    });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, network, extra) => execute(vm, wrap(body), {
        method: 'default', network, blockContext: LATE, ...extra,
    });
    it('charges result length beyond the identical repeat and concat control', async function () {
        const setup = `var s='x'.repeat(${K});`;
        const rawBody = `${setup}return String.raw({raw:['a','b']},s).length;`;
        const controlBody = `${setup}return ('a'+s+'b').length;`;
        const rawArmed = await run(rawBody, 'regtest', { gasCeiling: undefined });
        const rawLegacy = await run(rawBody, 'mainnet');
        const controlArmed = await run(controlBody, 'regtest', { gasCeiling: undefined });
        const controlLegacy = await run(controlBody, 'mainnet');
        for (const result of [rawArmed, rawLegacy, controlArmed, controlLegacy]) {
            assert.strictEqual(result.success, true, result.error);
        }
        assert.strictEqual(rawArmed.returnValue, controlArmed.returnValue);
        const rawDelta = rawArmed.gasUsed - rawLegacy.gasUsed;
        const controlDelta = controlArmed.gasUsed - controlLegacy.gasUsed;
        assert.ok(rawDelta - controlDelta >= K,
            `raw delta ${rawDelta}, same-length control delta ${controlDelta}`);
    });

    it('meters an extracted alias by its result length', async function () {
        const body = `var s='x'.repeat(${K}),raw=String.raw;return raw({raw:['a','b']},s).length;`;
        const armed = await run(body, 'regtest', { gasCeiling: undefined });
        const legacy = await run(body, 'mainnet');
        assert.strictEqual(armed.success, true, armed.error);
        assert.strictEqual(legacy.success, true, legacy.error);
        assert.strictEqual(armed.returnValue, legacy.returnValue);
        assert.ok(armed.gasUsed >= legacy.gasUsed + K,
            `${armed.gasUsed} vs ${legacy.gasUsed}`);
    });

    it('leaves legacy gas on unarmed, unknown and pre-arm testnet blocks', async function () {
        const body = `var s='x'.repeat(${K});return String.raw({raw:['a','b']},s).length;`;
        const gas = await legacyGas(run, body);
        assert.strictEqual(gas.mainnet, gas.testnet);
        assert.strictEqual(gas.undefined, gas.unknown);

        const armed = await runRegtestWithoutPerElement(run, body);
        // Before the v0.24.0 per-element instant, so only the String.raw meter separates it from legacy.
        const armedTestnet = await run(body, 'testnet', { gasCeiling: undefined, blockContext: { ...LATE, timestamp: 1792303199 } });
        assert.strictEqual(armedTestnet.gasUsed, armed.gasUsed);
        assert.ok(armed.gasUsed >= gas.mainnet + K);
    });
});
