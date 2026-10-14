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
 * Gas-ceiling exhaustion gate.
 *
 * A contract that swallows an in-isolate gas exhaustion and then throws a plain
 * Error reaches the classifier as a generic error carrying the tracker's raw
 * total, above the ceiling. Once the gate is active the run settles out_of_gas at
 * the ceiling; below it the legacy 'error:' result replays byte for byte.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const GasTracker = require('../../../src/gas.js');
const vmModule = require('../../../src/index.js');
const {
    GAS_CEILING_EXHAUSTED_ACTIVATION,
    resolveGasCeilingExhaustedActive,
    isGasCeilingExhaustedActive,
} = require('../../../src/index/gas_ceiling_exhausted_heights.js');
const { createVM, execute } = require('../../fuzz/helpers/harness.js');

const CEILING = 5000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const ADDRESS = 'C:BTC:1';
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
// Each body crosses the ceiling inside Object.keys, whose wrapper swallows the
// exhaustion, and then fails with an error that carries no gas class.
const SWALLOWED_NEAR_CEILING = `var a=new Array(4900).fill(1);Object.keys(a);throw new Error('x');`;
const SWALLOWED_THEN_THROW = `var a=new Array(3000).fill(1);Object.keys(a);throw new Error('after');`;
const SWALLOWED_THEN_TIMEOUT_TEXT = `var a=new Array(3000).fill(1);Object.keys(a);throw new Error('Script execution timed out.');`;
const SWALLOWED_THEN_RETURN = `var a=new Array(3000).fill(1);Object.keys(a);return 5;`;
const PRE = 'var a=new Array(3000).fill(1);Object.keys(a);';
// Every unmetered exit measured to escape the gate after a swallowed exhaustion,
// each reaching the classifier as a generic 'error:' with gasUsed 6008 > 5000.
const UNMETERED_EXITS = {
    plainThrow:             PRE + 'throw new Error("after");',
    throwString:            PRE + 'throw "s";',
    nativeTypeError:        PRE + 'var n=null; n.x;',
    referenceError:         PRE + 'notDefinedAnywhere;',
    throwObjNativeToString: PRE + 'throw {toString: Map.prototype.clear};',
    spoofRevert:            PRE + 'throw new Error("\\x03REVERT:spoof");',
    spoofTimeout:           PRE + 'throw new Error("Script execution timed out.");',
};
// A swallow at module top level, after which the dispatcher's own unknown-method throw ends the run.
const TOPLEVEL_SWALLOW_UNKNOWN_METHOD = PRE + 'module.exports = { other: function(){ return 1; } };';

describe('gas-ceiling exhaustion gate resolver', function () {
    const coins = ['BTC', 'LTC', 'DOGE'];

    it('exports a frozen six-chain map with every mainnet and testnet chain unarmed', function () {
        assert.ok(Object.isFrozen(GAS_CEILING_EXHAUSTED_ACTIVATION));
        assert.deepStrictEqual({ ...GAS_CEILING_EXHAUSTED_ACTIVATION }, {
            'BTC:mainnet': null, 'LTC:mainnet': null, 'DOGE:mainnet': null,
            'BTC:testnet': null, 'LTC:testnet': null, 'DOGE:testnet': null,
        });
    });

    it('is active on regtest from genesis', function () {
        assert.strictEqual(isGasCeilingExhaustedActive('regtest', 'BTC', 0), true);
        assert.strictEqual(isGasCeilingExhaustedActive('regtest', null, undefined), true);
    });

    it('keeps every mainnet and testnet chain unarmed at any height', function () {
        for (const net of ['mainnet', 'testnet']) {
            for (const coin of coins) {
                assert.strictEqual(isGasCeilingExhaustedActive(net, coin, 0), false, coin + ':' + net);
                assert.strictEqual(isGasCeilingExhaustedActive(net, coin, 1e9), false, coin + ':' + net);
            }
        }
    });

    it('resolves an unknown network, a missing coin or a non-finite height as inactive', function () {
        const armed = Object.freeze({ 'BTC:testnet': 10 });
        assert.strictEqual(resolveGasCeilingExhaustedActive(armed, 'testnet', 'BTC', 9), false);
        assert.strictEqual(resolveGasCeilingExhaustedActive(armed, 'testnet', 'BTC', 10), true);
        assert.strictEqual(resolveGasCeilingExhaustedActive(armed, 'testnet', null, 10), false);
        assert.strictEqual(resolveGasCeilingExhaustedActive(armed, 'testnet', 'BTC', NaN), false);
        for (const net of [undefined, null, 'unknown', '__proto__']) {
            assert.strictEqual(resolveGasCeilingExhaustedActive(armed, net, 'BTC', 10), false, String(net));
        }
    });

    it('is exposed on the entry point', function () {
        assert.strictEqual(vmModule.GAS_CEILING_EXHAUSTED_ACTIVATION, GAS_CEILING_EXHAUSTED_ACTIVATION);
        assert.strictEqual(vmModule.isGasCeilingExhaustedActive, isGasCeilingExhaustedActive);
    });
});

// One describe with a fresh VM per test; register receives the run helper.
function gateSuite(title, register) {
    describe(title, function () {
        this.timeout(60000);

        let vm;
        beforeEach(function () { vm = createVM({ gasCeiling: CEILING, maxCpuTimeMs: 30000 }); vm.beginBlock(); });
        afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

        register((code, network, method = 'default') => execute(vm, code, {
            method, network, contractAddress: ADDRESS, blockContext: LATE,
        }));
    });
}

gateSuite('gas-ceiling exhaustion gate execution', function (run) {
    it('settles a swallowed exhaustion followed by a plain throw as out_of_gas at the ceiling', async function () {
        for (const body of [SWALLOWED_NEAR_CEILING, SWALLOWED_THEN_THROW, SWALLOWED_THEN_TIMEOUT_TEXT]) {
            const r = await run(wrap(body), 'regtest');
            assert.strictEqual(r.success, false, body);
            assert.match(r.error, /^out_of_gas: used \d+ of 5000$/, body);
            assert.strictEqual(r.gasUsed, CEILING, body);
        }
    });

    it('settles every unmetered exit after a swallowed exhaustion as out_of_gas at the ceiling', async function () {
        for (const [name, body] of Object.entries(UNMETERED_EXITS)) {
            const shapes = [
                ['default', wrap(body)],
                ['initialize', `module.exports = { initialize: function(xchain) { ${body} } };`],
            ];
            for (const [method, code] of shapes) {
                const legacy = await run(code, 'mainnet', method);
                assert.strictEqual(legacy.success, false, name + ' ' + method);
                assert.match(legacy.error, /^error: /, name + ' ' + method + ' legacy: ' + legacy.error);
                assert.ok(legacy.gasUsed > CEILING, name + ' ' + method + ' legacy gasUsed ' + legacy.gasUsed);
                const r = await run(code, 'regtest', method);
                assert.strictEqual(r.success, false, name + ' ' + method);
                assert.match(r.error, /^out_of_gas: used \d+ of 5000$/, name + ' ' + method + ': ' + r.error);
                assert.strictEqual(r.gasUsed, CEILING, name + ' ' + method);
            }
        }
    });

    it('settles a module-level swallow ended by the unknown-method throw as out_of_gas at the ceiling', async function () {
        for (const method of ['default', 'initialize']) {
            const legacy = await run(TOPLEVEL_SWALLOW_UNKNOWN_METHOD, 'mainnet', method);
            assert.strictEqual(legacy.error, 'error: unknown method: ' + method);
            assert.ok(legacy.gasUsed > CEILING, method + ' legacy gasUsed ' + legacy.gasUsed);
            const r = await run(TOPLEVEL_SWALLOW_UNKNOWN_METHOD, 'regtest', method);
            assert.match(r.error, /^out_of_gas:/, method + ': ' + r.error);
            assert.strictEqual(r.gasUsed, CEILING, method);
        }
    });

    it('settles a constructor that does the same as out_of_gas at the ceiling', async function () {
        const code = `module.exports = { initialize: function() { ${SWALLOWED_NEAR_CEILING} } };`;
        const r = await run(code, 'regtest', 'initialize');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/);
        assert.strictEqual(r.gasUsed, CEILING);
    });
});

gateSuite('gas-ceiling exhaustion gate execution: unarmed replay and the success path', function (run) {
    // Measured on the tree before this gate existed. The raw totals differ by network
    // because the block-time gates ahead of the run move a few metered charges.
    const LEGACY = [
        ['mainnet', 9805, 6005],
        ['testnet', 9808, 6008],
        [undefined, 9804, 6004],
    ];

    it('replays the legacy generic error with its raw gasUsed while unarmed', async function () {
        for (const [net, nearGas, afterGas] of LEGACY) {
            const near = await run(wrap(SWALLOWED_NEAR_CEILING), net);
            assert.deepStrictEqual([near.success, near.error, near.gasUsed], [false, 'error: x', nearGas], String(net));
            const after = await run(wrap(SWALLOWED_THEN_THROW), net);
            assert.deepStrictEqual([after.success, after.error, after.gasUsed], [false, 'error: after', afterGas], String(net));
        }
    });

    it('leaves a plain throw that never crossed the ceiling as a generic error with its real gasUsed', async function () {
        const r = await run(wrap(`throw new Error('plain');`), 'regtest');
        assert.strictEqual(r.error, 'error: plain');
        assert.ok(r.gasUsed > 0 && r.gasUsed < CEILING);
    });

    it('covers the success path where the success gate is not armed', async function () {
        const original = GasTracker.isGasCeilingSuccessActive;
        GasTracker.isGasCeilingSuccessActive = () => false;
        try {
            const armed = await run(wrap(SWALLOWED_THEN_RETURN), 'regtest');
            assert.strictEqual(armed.success, false);
            assert.match(armed.error, /^out_of_gas:/);
            assert.strictEqual(armed.gasUsed, CEILING);
            const unarmed = await run(wrap(SWALLOWED_THEN_RETURN), 'mainnet');
            assert.strictEqual(unarmed.success, true);
            assert.strictEqual(unarmed.gasUsed, 6005);
        } finally {
            GasTracker.isGasCeilingSuccessActive = original;
        }
    });
});
