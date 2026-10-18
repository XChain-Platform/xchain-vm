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
 * Annex B String HTML result-length metering gate.
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
// The v0.25.0 cut arms the string-result meter on testnet at this block time.
const TESTNET_ARMED = 1792416600;
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const METHODS = [
    ['anchor', `'x'.repeat(${K})`],
    ['big'],
    ['blink'],
    ['bold'],
    ['fixed'],
    ['fontcolor', `'x'.repeat(${K})`],
    ['fontsize', `'x'.repeat(${K})`],
    ['italics'],
    ['link', `'x'.repeat(${K})`],
    ['small'],
    ['strike'],
    ['sub'],
    ['sup'],
];

function stringHtmlHarnessFragment() {
    const start = harnessPart5.indexOf('        var __meterStringResult');
    const end = harnessPart5.indexOf('        // resize/transfer', start);
    assert.ok(start >= 0 && end > start, 'String HTML harness fragment');
    return harnessPart5.slice(start, end);
}

describe('Annex B String HTML result-length wrapper', function () {
    it('charges the exact returned string length for all 13 methods', function () {
        const context = nodeVM.createContext({});
        const source = `
            var charged = 0, __stringResultMeterOn = true;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${stringHtmlHarnessFragment()}
            var methods = ${JSON.stringify(METHODS.map(([name]) => name))};
            var results = methods.map(function(name) {
                charged = 0;
                var arg = name === 'anchor' || name === 'fontcolor' ||
                    name === 'fontsize' || name === 'link' ? 'x'.repeat(${K}) : undefined;
                var result = String.prototype[name].call('a', arg);
                return [name, charged, result.length];
            });`;
        nodeVM.runInContext(source, context);
        assert.deepStrictEqual(Array.from(context.results, (row) => Array.from(row)),
            METHODS.map(([name]) => {
                const arg = ['anchor', 'fontcolor', 'fontsize', 'link'].includes(name)
                    ? 'x'.repeat(K) : undefined;
                const result = String.prototype[name].call('a', arg);
                return [name, result.length, result.length];
            }));
    });
});

function defineMethodCases(run) {
    for (const [method, arg = ''] of METHODS) {
        it(`${method} is charged by its returned string length`, async function () {
            const body = `return 'a'.${method}(${arg}).length;`;
            const armed = await run(body, 'regtest', { gasCeiling: undefined });
            const unarmed = await run(body, 'mainnet', { gasCeiling: undefined });
            assert.strictEqual(armed.success, true, `${method}: ${armed.error}`);
            assert.strictEqual(unarmed.success, true, `${method}: ${unarmed.error}`);
            assert.strictEqual(armed.returnValue, unarmed.returnValue, method);
            const resultLength = Number(armed.returnValue);
            assert.ok(armed.gasUsed - unarmed.gasUsed >= resultLength,
                `${method}: ${armed.gasUsed} vs ${unarmed.gasUsed}`);
        });
    }
}

function defineWallCase(run) {
    it('a reused large attribute ends in out_of_gas under the wall', async function () {
        const body = `var x='x'.repeat(${K});var t=0;for(;;){t+='a'.anchor(x).length;}`;
        const t0 = Date.now();
        const result = await run(body, 'regtest');
        assert.strictEqual(result.success, false);
        assert.match(result.error, /^out_of_gas:/, result.error);
        assert.ok(Date.now() - t0 < WALL_MS);
    });
}

function defineCoercionCase(run) {
    it('preserves native receiver and attribute coercion', async function () {
        const body = `var receiverCalls=0,attributeCalls=0;
            var receiver={toString:function(){receiverCalls++;return 'a';}};
            var attribute={toString:function(){attributeCalls++;return 'x"y';}};
            var result=String.prototype.anchor.call(receiver,attribute);
            return [result,receiverCalls,attributeCalls];`;
        const armed = await run(body, 'regtest');
        const unarmed = await run(body, 'mainnet');
        assert.strictEqual(armed.success, true, armed.error);
        assert.strictEqual(unarmed.success, true, unarmed.error);
        assert.strictEqual(armed.returnValue, unarmed.returnValue);
        assert.deepStrictEqual(JSON.parse(armed.returnValue).slice(1), [1, 1]);
    });
}

function defineLegacyGasCase(run) {
    it('leaves legacy gas on unarmed and unknown networks', async function () {
        const body = `return 'a'.anchor('x'.repeat(${K})).length;`;
        const gas = {};
        // Block time 0 runs testnet before its armed instant.
        assert.strictEqual(runtime.STRING_RESULT_METER_ACTIVATION.mainnet, null);
        assert.strictEqual(runtime.STRING_RESULT_METER_ACTIVATION.testnet, TESTNET_ARMED);
        for (const network of ['mainnet', 'testnet', undefined, 'unknown']) {
            const result = await run(body, network, {
                blockContext: { ...LATE, timestamp: 0 },
            });
            assert.strictEqual(result.success, true, `${network}: ${result.error}`);
            gas[String(network)] = result.gasUsed;
        }
        assert.strictEqual(gas.mainnet, gas.testnet);
        assert.strictEqual(gas.undefined, gas.unknown);

        const armed = await run(body, 'regtest', { gasCeiling: undefined });
        assert.ok(armed.gasUsed >= gas.mainnet + K);
    });

    it('meters testnet from its v0.25.0 instant and not one second before', async function () {
        const body = `return 'a'.anchor('x'.repeat(${K})).length;`;
        const before = await run(body, 'testnet', {
            blockContext: { ...LATE, timestamp: TESTNET_ARMED - 1 }, gasCeiling: undefined,
        });
        const at = await run(body, 'testnet', {
            blockContext: { ...LATE, timestamp: TESTNET_ARMED }, gasCeiling: undefined,
        });
        assert.strictEqual(before.success, true, before.error);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(at.returnValue, before.returnValue);
        assert.ok(at.gasUsed >= before.gasUsed + K, `${at.gasUsed} vs ${before.gasUsed}`);
    });
}

(XChainVM ? describe : describe.skip)('Annex B String HTML metering gate', function () {
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

    defineMethodCases(run);
    defineWallCase(run);
    defineCoercionCase(run);
    defineLegacyGasCase(run);
});
