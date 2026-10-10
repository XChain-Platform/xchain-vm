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
 * Sparse callback Array method metering gate.
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
const METHODS = [
    ['every', 'function(){return true;}'],
    ['filter', 'function(){return true;}'],
    ['flatMap', 'function(v){return [v];}'],
    ['forEach', 'function(){}'],
    ['map', 'function(v){return v;}'],
    ['reduce', 'function(a,v){return a+v;},0'],
    ['reduceRight', 'function(a,v){return a+v;},0'],
    ['some', 'function(){return false;}'],
];

// eslint-disable-next-line camelcase
async function sparse_callback_methods_are_charged_after_the_call(run, receiver) {
    for (const [method, args] of METHODS) {
        const body = `${receiver}Array.prototype.${method}.call(a,${args});return 1;`;
        const armed = await run(body, 'regtest', { gasCeiling: undefined });
        const unarmed = await run(body, 'mainnet', { gasCeiling: undefined });
        assert.strictEqual(armed.success, true, `${method}: ${armed.error}`);
        assert.strictEqual(unarmed.success, true, `${method}: ${unarmed.error}`);
        assert.ok(armed.gasUsed >= unarmed.gasUsed + K - 10,
            `${method}: ${armed.gasUsed} vs ${unarmed.gasUsed}`);
    }
}

function registerSparseScanCases(run) {
    it('charges every hole-skipping callback method on a sparse Array', async function () {
        await sparse_callback_methods_are_charged_after_the_call(
            run, `var a=new Array(${K});`);
    });

    it('charges every hole-skipping callback method on an array-like receiver', async function () {
        await sparse_callback_methods_are_charged_after_the_call(
            run, `var a={length:${K}};`);
    });

    for (const [name, receiver, call] of [
        ['some', `var a=new Array(${K});`, 'a.some(function(){return false;})'],
        ['flatMap', `var a=new Array(${K});`, 'a.flatMap(function(v){return [v];})'],
        ['array-like forEach', `var a={length:${K}};`,
            'Array.prototype.forEach.call(a,function(){})'],
    ]) {
        it(`${name}: a hostile loop ends in out_of_gas under the wall`, async function () {
            const t0 = Date.now();
            const r = await run(`${receiver}for(;;){${call};}`, 'regtest');
            assert.strictEqual(r.success, false, name);
            assert.match(r.error, /^out_of_gas:/, `${name}: ${r.error}`);
            assert.ok(Date.now() - t0 < WALL_MS, name);
        });
    }

    it('charges a sparse scan even when the callback throws and the contract catches it', async function () {
        const body = `var a=new Array(${K});a[${K - 1}]=1;for(;;){
            try{a.forEach(function(){throw new Error('stop');});}catch(e){}
        }`;
        const r = await run(body, 'regtest');
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
    });
}

function registerNetworkCases(run) {
    it('leaves the legacy flat charge on unarmed and unknown networks', async function () {
        const body = `var a=new Array(${K});a.some(function(){return false;});return 1;`;
        const gas = {};
        for (const network of ['mainnet', 'testnet', undefined, 'unknown']) {
            const r = await run(body, network, { gasCeiling: undefined });
            assert.strictEqual(r.success, true, `${network}: ${r.error}`);
            gas[String(network)] = r.gasUsed;
        }
        assert.strictEqual(gas.mainnet, gas.testnet);
        assert.strictEqual(gas.undefined, gas.unknown);
    });
}

function registerFailedProbeCases(run) {
    it('preserves native results when the temporary length probe cannot be installed', async function () {
        const receivers = [
            ['non-configurable accessor',
                `var reads=0,coercions=0,size={valueOf:function(){coercions++;return 3;}},
                a=Object.freeze({get length(){reads++;return size;}});`,
                [1, 1]],
            ['non-extensible inherited accessor',
                `var reads=0,coercions=0,size={valueOf:function(){coercions++;return 3;}},
                p={get length(){reads++;return size;}},a=Object.preventExtensions(Object.create(p));`,
                [1, 1]],
            ['non-configurable object value',
                `var reads=0,coercions=0,size={valueOf:function(){coercions++;return 3;}},
                a=Object.freeze({length:size});`,
                [0, 1]],
        ];
        for (const [receiver, setup, expected] of receivers) {
            for (const [method, args] of METHODS) {
                const body = `${setup}var result=Array.prototype.${method}.call(a,${args});
                    return [reads,coercions,result];`;
                const armed = await run(body, 'regtest');
                const unarmed = await run(body, 'mainnet');
                assert.strictEqual(armed.success, true, `${receiver} ${method}: ${armed.error}`);
                assert.strictEqual(unarmed.success, true, `${receiver} ${method}: ${unarmed.error}`);
                assert.deepStrictEqual(JSON.parse(armed.returnValue).slice(0, 2), expected,
                    `${receiver} ${method}`);
                assert.strictEqual(armed.returnValue, unarmed.returnValue,
                    `${receiver} ${method}`);
            }
        }
    });
}

function sparseCallbackHarnessFragment() {
    const start = harnessPart5.indexOf('    if (__applyLengthMeterOn) {');
    const end = harnessPart5.indexOf('        var __fnProto', start);
    assert.ok(start >= 0 && end > start, 'sparse callback harness fragment');
    return harnessPart5.slice(start, end) + '    }\n';
}

function registerProxyProbeCase() {
    it('charges the native scan when a Proxy reports a smaller length descriptor', function () {
        const context = nodeVM.createContext({});
        const source = `
            var charged = 0;
            var __applyLengthMeterOn = true;
            var __hasOwn = Object.prototype.hasOwnProperty;
            var __getOwnDesc = Object.getOwnPropertyDescriptor;
            var __getProto = Object.getPrototypeOf;
            var __defProp = Object.defineProperty;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${sparseCallbackHarnessFragment()}
            var K = ${K};
            var results = [];
            [true,false].forEach(function(configurable) {
                charged = 0;
                var target = {};
                Object.defineProperty(target,'length',{
                    value:1,writable:true,enumerable:true,configurable:configurable
                });
                var receiver = new Proxy(target, {
                    getOwnPropertyDescriptor:function(t,k) {
                        if (k === 'length') return {
                            value:1,writable:true,enumerable:true,configurable:configurable
                        };
                        return Object.getOwnPropertyDescriptor(t,k);
                    },
                    get:function(t,k,r) { return k === 'length' ? K : Reflect.get(t,k,r); },
                    has:function() { return false; }
                });
                Array.prototype.some.call(receiver,function(){return false;});
                results.push([charged,Object.getOwnPropertyDescriptor(target,'length').value]);
            });`;
        nodeVM.runInContext(source, context);
        assert.ok(context.results[0][0] >= Number.MAX_SAFE_INTEGER);
        assert.ok(context.results[1][0] >= K);
        assert.deepStrictEqual(Array.from(context.results, (row) => Array.from(row)),
            [[context.results[0][0], 1], [K, 1]]);
    });
}

function registerDescriptorlessProxyProbeCase() {
    it('charges a virtual Proxy length with no reported descriptor', function () {
        const context = nodeVM.createContext({});
        const source = `
            var charged = 0;
            var __applyLengthMeterOn = true;
            var __hasOwn = Object.prototype.hasOwnProperty;
            var __getOwnDesc = Object.getOwnPropertyDescriptor;
            var __getProto = Object.getPrototypeOf;
            var __defProp = Object.defineProperty;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${sparseCallbackHarnessFragment()}
            var K = ${K};
            var plain = {};
            Array.prototype.some.call(plain,function(){return false;});
            var plainResult = [charged,Object.prototype.hasOwnProperty.call(plain,'length')];
            charged = 0;
            var target = {};
            var receiver = new Proxy(target, {
                getOwnPropertyDescriptor:function(t,k) {
                    if (k === 'length') return undefined;
                    return Object.getOwnPropertyDescriptor(t,k);
                },
                get:function(t,k,r) { return k === 'length' ? K : Reflect.get(t,k,r); },
                has:function() { return false; }
            });
            Array.prototype.some.call(receiver,function(){return false;});
            var result = [charged,Object.prototype.hasOwnProperty.call(target,'length')];`;
        nodeVM.runInContext(source, context);
        assert.deepStrictEqual(Array.from(context.plainResult), [0, false]);
        assert.deepStrictEqual(Array.from(context.result), [Number.MAX_SAFE_INTEGER, false]);
    });
}

function registerBypassedProbeWriteCases() {
    it('preserves callback writes when a Proxy bypasses the temporary length getter', function () {
        const context = nodeVM.createContext({});
        const source = `
            var charged = 0;
            var __applyLengthMeterOn = true;
            var __hasOwn = Object.prototype.hasOwnProperty;
            var __getOwnDesc = Object.getOwnPropertyDescriptor;
            var __getProto = Object.getPrototypeOf;
            var __defProp = Object.defineProperty;
            var __allocGas = function(n) { charged += n; };
            var __lockMethod = function(o, k, fn) {
                Object.defineProperty(o, k, {value:fn,writable:false,configurable:false});
            };
            ${sparseCallbackHarnessFragment()}
            var run = function(inherited) {
                charged = 0;
                var proto = inherited ? {length:1} : Object.prototype;
                var target = Object.create(proto);
                if (!inherited) Object.defineProperty(target,'length',{
                    value:1,writable:true,configurable:true
                });
                target[0] = 3;
                var receiver = new Proxy(target, {
                    get:function(t,k,r) { return k === 'length' ? 1 : Reflect.get(t,k,r); }
                });
                Array.prototype.forEach.call(receiver,function() { receiver.length = 7; });
                return [charged,target.length,
                    Object.prototype.hasOwnProperty.call(target,'length')];
            };
            var ownResult = run(false);
            var inheritedResult = run(true);`;
        nodeVM.runInContext(source, context);
        assert.deepStrictEqual(Array.from(context.ownResult), [Number.MAX_SAFE_INTEGER, 7, true]);
        assert.deepStrictEqual(Array.from(context.inheritedResult),
            [Number.MAX_SAFE_INTEGER, 7, true]);
    });
}

function registerActivationCase(run) {
    it('reads and coerces an accessor-backed length only once', async function () {
        for (const [method, args] of METHODS) {
            const body = `var reads=0,coercions=0,size={valueOf:function(){coercions++;return ${K};}},
                a={get length(){reads++;return size;}};
                Array.prototype.${method}.call(a,${args});return [reads,coercions];`;
            const armed = await run(body, 'regtest');
            const unarmed = await run(body, 'mainnet');
            assert.strictEqual(armed.success, true, `${method}: ${armed.error}`);
            assert.strictEqual(unarmed.success, true, `${method}: ${unarmed.error}`);
            assert.deepStrictEqual(JSON.parse(armed.returnValue), [1, 1], method);
            assert.strictEqual(armed.returnValue, unarmed.returnValue, method);
            assert.ok(armed.gasUsed >= unarmed.gasUsed + K - 10,
                `${method}: ${armed.gasUsed} vs ${unarmed.gasUsed}`);
        }
    });

    it('restores the length accessor before callbacks run', async function () {
        const body = `var reads=0,a={0:7,get length(){reads++;return 1;}};
            var value=Array.prototype.map.call(a,function(v){return [v,a.length,reads];})[0];
            return [reads,value];`;
        const armed = await run(body, 'regtest');
        const unarmed = await run(body, 'mainnet');
        assert.strictEqual(armed.success, true, armed.error);
        assert.deepStrictEqual(JSON.parse(armed.returnValue), [2, [7, 1, 2]]);
        assert.strictEqual(armed.returnValue, unarmed.returnValue);
    });

    it('uses the apply-length activation without changing native results', async function () {
        const body = `var a=new Array(4);a[2]=7;return [
            a.map(function(v){return v+1;}).join(','),
            a.filter(function(v){return v>0;}).join(','),
            a.reduce(function(s,v){return s+v;},0)
        ];`;
        const armed = await run(body, 'regtest');
        const unarmed = await run(body, 'mainnet');
        assert.strictEqual(armed.success, true, armed.error);
        assert.deepStrictEqual(JSON.parse(armed.returnValue), [',,8,', '7', 7]);
        assert.deepStrictEqual(armed.returnValue, unarmed.returnValue);

        const activation = runtime.APPLY_LENGTH_METER_ACTIVATION;
        const saved = activation.regtest;
        activation.regtest = null;
        try {
            const disabled = await run(`var a=new Array(${K});a.some(function(){return false;});return 1;`,
                'regtest', { gasCeiling: undefined });
            const legacy = await run(`var a=new Array(${K});a.some(function(){return false;});return 1;`,
                'mainnet', { gasCeiling: undefined });
            assert.strictEqual(disabled.gasUsed, legacy.gasUsed);
        } finally {
            activation.regtest = saved;
        }
    });
}

function sparseCallbackMeteringSuite() {
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
    registerSparseScanCases(run);
    registerNetworkCases(run);
    registerFailedProbeCases(run);
    registerProxyProbeCase();
    registerDescriptorlessProxyProbeCase();
    registerBypassedProbeWriteCases();
    registerActivationCase(run);
}

(XChainVM ? describe : describe.skip)(
    'sparse callback Array method metering gate', sparseCallbackMeteringSuite);
