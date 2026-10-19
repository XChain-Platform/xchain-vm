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
 * String receiver metering activation and charge coverage.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');
const {
    STRING_RECEIVER_METER_ACTIVATION,
    isStringReceiverMeterActive,
} = require('../../../src/index/string_receiver_meter.js');

const K = 4000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function() { ${body} };`;
const RECEIVER = `var s=new Array(${K + 1}).join('x');` +
    'var o={length:0,toString:function(){return s;}};';

// The v0.25.0 cut arms the string receiver meter on testnet at this block time.
const TESTNET_ARMED = 1792454400;
const TESTNET_BEFORE = { ...LATE, timestamp: TESTNET_ARMED - 1 };
const TESTNET_AT = { ...LATE, timestamp: TESTNET_ARMED };

async function run(body, network, blockContext = LATE) {
    const vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    try {
        return await execute(vm, wrap(body), { method: 'default', network, blockContext });
    } finally { if (vm.endBlock) vm.endBlock(); }
}

async function pair(body) {
    const on = await run(body, 'regtest');
    const saved = STRING_RECEIVER_METER_ACTIVATION.regtest;
    STRING_RECEIVER_METER_ACTIVATION.regtest = null;
    try {
        const off = await run(body, 'regtest');
        assert.strictEqual(on.success, true, 'armed: ' + on.error);
        assert.strictEqual(off.success, true, 'unarmed: ' + off.error);
        assert.strictEqual(on.returnValue, off.returnValue);
        return { on, off };
    } finally {
        STRING_RECEIVER_METER_ACTIVATION.regtest = saved;
    }
}

describe('string receiver meter: activation', function () {
    it('is armed on regtest from genesis and on testnet from its v0.25.0 instant', function () {
        assert.deepStrictEqual(STRING_RECEIVER_METER_ACTIVATION, {
            mainnet: null, testnet: TESTNET_ARMED, regtest: 0,
        });
        assert.strictEqual(Object.isSealed(STRING_RECEIVER_METER_ACTIVATION), true);
        assert.strictEqual(isStringReceiverMeterActive('regtest', 0), true);
        for (const network of ['mainnet', 'unknown', undefined]) {
            assert.strictEqual(isStringReceiverMeterActive(network, LATE.timestamp), false, String(network));
        }
        assert.strictEqual(isStringReceiverMeterActive('testnet', TESTNET_ARMED - 1), false);
        assert.strictEqual(isStringReceiverMeterActive('testnet', TESTNET_ARMED), true);
    });
});

(XChainVM ? describe : describe.skip)('string receiver meter: generic String receivers', function () {
    this.timeout(60000);

    for (const [name, call] of [
        ['repeat', 'String.prototype.repeat.call(o,1).length'],
        ['concat', "String.prototype.concat.call(o,'').length"],
        ['replace', "String.prototype.replace.call(o,s,'').length"],
        ['replaceAll', "String.prototype.replaceAll.call(o,s,'').length"],
        ['__meterLen', "String.prototype.indexOf.call(o,'!')"],
    ]) {
        it(`${name} charges the coerced string instead of a spoofed length`, async function () {
            const { on, off } = await pair(`${RECEIVER}return ${call};`);
            assert.ok(on.gasUsed >= off.gasUsed + K,
                `${name}: armed ${on.gasUsed}, unarmed ${off.gasUsed}`);
        });
    }

    it('does not change the shared __meterLen charge for Array methods', async function () {
        const body = `var a=new Array(${K}).fill(1);return Array.prototype.indexOf.call(a,-1);`;
        const { on, off } = await pair(body);
        assert.strictEqual(on.gasUsed, off.gasUsed);
    });

    it('mainnet and testnet before its v0.25.0 instant retain the legacy undercharge', async function () {
        const body = `${RECEIVER}return String.prototype.indexOf.call(o,'!');`;
        const armed = await run(body, 'regtest');
        const mainnet = await run(body, 'mainnet');
        const testnet = await run(body, 'testnet', TESTNET_BEFORE);
        assert.strictEqual(armed.success, true, armed.error);
        assert.strictEqual(mainnet.success, true, mainnet.error);
        assert.strictEqual(testnet.success, true, testnet.error);
        assert.strictEqual(armed.returnValue, mainnet.returnValue);
        assert.strictEqual(mainnet.returnValue, testnet.returnValue);
        assert.ok(armed.gasUsed >= mainnet.gasUsed + K);
        assert.ok(armed.gasUsed >= testnet.gasUsed + K);
    });

    it('testnet charges the coerced receiver from its v0.25.0 instant', async function () {
        const body = `${RECEIVER}return String.prototype.indexOf.call(o,'!');`;
        const before = await run(body, 'testnet', TESTNET_BEFORE);
        const at = await run(body, 'testnet', TESTNET_AT);
        assert.strictEqual(before.success, true, before.error);
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(at.returnValue, before.returnValue);
        assert.ok(at.gasUsed >= before.gasUsed + K, `${at.gasUsed} vs ${before.gasUsed}`);
    });
});
