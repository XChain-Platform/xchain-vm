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
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');
const { TOSTRING_SIZE_METER_ACTIVATION } = require('../../../src/index/tostring_size_meter.js');
const { ARGUMENT_LENGTH, VECTORS } = require('./helpers/vectors.js');

const CONTEXT = { height: 100, timestamp: 4000000000, hash: 'tostring-size' };
const OPTIONS = { method: 'default', network: 'regtest', blockContext: CONTEXT };

async function run(code) {
    const vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    try { return await execute(vm, code, OPTIONS); }
    finally { if (vm.endBlock) vm.endBlock(); }
}

async function runBelowGate(code) {
    const saved = TOSTRING_SIZE_METER_ACTIVATION.regtest;
    TOSTRING_SIZE_METER_ACTIVATION.regtest = 9999999999;
    try {
        return await run(code);
    } finally {
        TOSTRING_SIZE_METER_ACTIVATION.regtest = saved;
    }
}

async function acrossGate(code) {
    const armed = await run(code);
    const below = await runBelowGate(code);
    assert.strictEqual(armed.success, true, 'armed: ' + armed.error);
    assert.strictEqual(below.success, true, 'below the gate: ' + below.error);
    assert.strictEqual(armed.returnValue, below.returnValue);
    return { armed, below };
}

(XChainVM ? describe : describe.skip)('toString size meter: coercion probe', function () {
    this.timeout(60000);

    for (const fn of [...new Set(VECTORS.map((vector) => vector.fn))]) {
        it(`${fn} charges new String and toString results once`, async function () {
            for (const vector of VECTORS.filter((entry) => entry.fn === fn)) {
                const { armed, below } = await acrossGate(vector.code);
                const delta = armed.gasUsed - below.gasUsed;
                if (vector.form === 'primitive') assert.strictEqual(delta, 0, fn);
                else {
                    assert.ok(delta >= ARGUMENT_LENGTH, `${fn} ${vector.form}: ${delta}`);
                    assert.ok(delta < ARGUMENT_LENGTH * 2, `${fn} ${vector.form} charged once: ${delta}`);
                }
            }
        });
    }

    for (const fn of ['decodeURIComponent', 'parseInt']) {
        it(`${fn} runs object conversion exactly once`, async function () {
            const radix = fn === 'parseInt' ? ',10' : '';
            for (const input of [
                'var input={toString:function(){calls++;return s;}};',
                'var input={toString:null,valueOf:function(){calls++;return s;}};',
                'var input=new String(s);input.toString=function(){calls++;return s;};',
            ]) {
                const code = `module.exports=function(){var s=String(5).repeat(${ARGUMENT_LENGTH}),calls=0;${input}` +
                    `var result=${fn}(input${radix});return [typeof result,calls];};`;
                const { armed } = await acrossGate(code);
                assert.deepStrictEqual(JSON.parse(armed.returnValue), [fn === 'parseInt' ? 'number' : 'string', 1]);
            }
        });
    }

    for (const method of ['padStart', 'padEnd']) {
        it(`${method} converts its target length once above the gate`, async function () {
            const code = `module.exports=function(){var calls=0,len={valueOf:function(){calls++;return 5;}};
                return ['x'[${JSON.stringify(method)}](len,'y'),calls];};`;
            const armed = await run(code);
            const below = await runBelowGate(code);
            assert.strictEqual(armed.success, true, 'armed: ' + armed.error);
            assert.strictEqual(below.success, true, 'below the gate: ' + below.error);
            assert.deepStrictEqual(JSON.parse(armed.returnValue), [method === 'padStart' ? 'yyyyx' : 'xyyyy', 1]);
            assert.deepStrictEqual(JSON.parse(below.returnValue), [method === 'padStart' ? 'yyyyx' : 'xyyyy', 2]);
        });
    }

    it('preserves native constructor rejection above the gate', async function () {
        const code = `module.exports=function(){return ['decodeURIComponent','parseInt'].map(function(name){
            try { new globalThis[name]('5'); return 'accepted'; } catch (e) { return e.name; }
        });};`;
        const armed = await run(code);
        assert.strictEqual(armed.success, true, armed.error);
        assert.deepStrictEqual(JSON.parse(armed.returnValue), ['TypeError', 'TypeError']);
    });

    it('leaves Symbol rejection to each native global function', async function () {
        const code = `module.exports=function(){return ['decodeURIComponent','parseInt'].map(function(name){
            try { globalThis[name](Symbol('x')); return 'accepted'; } catch (e) { return e.name; }
        });};`;
        const { armed } = await acrossGate(code);
        assert.deepStrictEqual(JSON.parse(armed.returnValue), ['TypeError', 'TypeError']);
    });
});
