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
 * Per-element metering gate: iterator helpers, Set algebra with a
 * set-like argument, String.raw segments and small object spread/rest.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');
const { PER_ELEMENT_METER_ACTIVATION, isPerElementMeterActive } = require('../../../src/index/per_element_meter.js');

const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const wrap = (body) => `module.exports = function(xchain) { ${body} };`;
const SIZES = [100, 200, 400];

// Each family: a body builder over N and the gas each element must add at least.
const FILL = (n) => `var big=new Array(${n}).fill(1);`;
const SEQ = (n) => `var big=new Array(${n}).fill(0); for (var i=0;i<${n};i++) big[i]=i;`;
const SETLIKE = (n) => SEQ(n) + 'var o={size:0, has:function(){return false;}, keys:function(){return big.values();}}; var a=new Set([-1]);';
const OBJ = (n) => `var o={}; for (var i=0;i<${n};i++) o['k'+i]=i;`;
const FAMILIES = {
    'iterator map + some (native callbacks)': [(n) => FILL(n) + 'return big.values().map(Math.abs).some(Number.isNaN) ? 1 : 0;', 3],
    'iterator filter (native callback)': [(n) => FILL(n) + 'return big.values().filter(Number.isNaN).toArray().length;', 1],
    'iterator take + some': [(n) => FILL(n) + 'return big.values().take(1e9).some(Number.isNaN) ? 1 : 0;', 2],
    'iterator drop + some': [(n) => FILL(n) + 'return big.values().drop(1).some(Number.isNaN) ? 1 : 0;', 1.5],
    'iterator reduce (native callback)': [(n) => FILL(n) + 'return big.values().reduce(Math.max, 0);', 1],
    'iterator every / find / forEach': [(n) => FILL(n) +
        'var c=0; big.values().forEach(Number.isNaN); c+=big.values().every(Number.isFinite)?1:0; c+=big.values().find(Number.isNaN)===undefined?1:0; return c;', 3],
    'iterator flatMap + some': [(n) => FILL(n) + 'return [0,0,0,0].values().flatMap(function(){return big;}).some(Number.isNaN) ? 1 : 0;', 8],
    'Set union, set-like argument': [(n) => SETLIKE(n) + 'return a.union(o).size;', 1],
    'Set intersection, set-like argument': [(n) => SETLIKE(n) + 'return a.intersection(o).size;', 1],
    'Set difference, set-like argument': [(n) => SETLIKE(n) + 'return a.difference(o).size;', 1],
    'Set symmetricDifference, set-like argument': [(n) => SETLIKE(n) + 'return a.symmetricDifference(o).size;', 1],
    'Set isDisjointFrom, set-like argument': [(n) => SETLIKE(n) + 'return a.isDisjointFrom(o) ? 1 : 0;', 1],
    'Set isSupersetOf, set-like argument': [(n) => SEQ(n) +
        'var a=new Set(big); var o={size:0, has:function(){return true;}, keys:function(){return big.values();}}; return a.isSupersetOf(o) ? 1 : 0;', 1],
    'String.raw empty segments': [(n) => `var e=new Array(${n}).fill(""); return String.raw({raw:e}).length;`, 1],
    'object rest below 256 keys': [(n) => OBJ(n / 4) + 'var {k0, ...r} = o; return 1;', 0.25],
    'object spread below 256 keys': [(n) => OBJ(n / 4) + 'var r = {...o}; return 1;', 0.25],
};

// Gas the legacy tree (the parent commit, no per-element charge) reports for the same
// bodies at N = 100, on mainnet and on regtest. Pinned so the unarmed path is proven to
// be the legacy path, not merely equal to itself.
const LEGACY_GAS = {
    'iterator map + some (native callbacks)': { mainnet: 108, regtest: 111 },
    'iterator filter (native callback)': { mainnet: 107, regtest: 110 },
    'iterator take + some': { mainnet: 108, regtest: 111 },
    'iterator drop + some': { mainnet: 108, regtest: 111 },
    'iterator reduce (native callback)': { mainnet: 108, regtest: 111 },
    'iterator every / find / forEach': { mainnet: 112, regtest: 115 },
    'iterator flatMap + some': { mainnet: 112, regtest: 115 },
    'Set union, set-like argument': { mainnet: 311, regtest: 314 },
    'Set intersection, set-like argument': { mainnet: 308, regtest: 311 },
    'Set difference, set-like argument': { mainnet: 308, regtest: 311 },
    'Set symmetricDifference, set-like argument': { mainnet: 311, regtest: 314 },
    'Set isDisjointFrom, set-like argument': { mainnet: 309, regtest: 312 },
    'Set isSupersetOf, set-like argument': { mainnet: 408, regtest: 611 },
    'String.raw empty segments': { mainnet: 105, regtest: 108 },
    'object rest below 256 keys': { mainnet: 53, regtest: 56 },
    'object spread below 256 keys': { mainnet: 53, regtest: 56 },
};

async function run(body, network) {
    const vm = createVM({ gasCeiling: 10000000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    try {
        return await execute(vm, wrap(body), { method: 'default', network, blockContext: LATE });
    } finally { if (vm.endBlock) vm.endBlock(); }
}
// Runs the body on regtest with only this gate switched off; every other regtest
// gate stays as it is, so a gas difference belongs to this gate alone.
async function runOff(body) {
    const saved = PER_ELEMENT_METER_ACTIVATION.regtest;
    PER_ELEMENT_METER_ACTIVATION.regtest = null;
    try { return await run(body, 'regtest'); } finally { PER_ELEMENT_METER_ACTIVATION.regtest = saved; }
}
async function pair(body) {
    const on = await run(body, 'regtest');
    const off = await runOff(body);
    assert.strictEqual(on.success, true, 'armed: ' + on.error);
    assert.strictEqual(off.success, true, 'unarmed: ' + off.error);
    assert.strictEqual(on.returnValue, off.returnValue, 'armed and unarmed results differ');
    return { on, off, delta: on.gasUsed - off.gasUsed };
}

// One family: armed gas grows exactly linearly with N; unarmed gas matches mainnet's result
// and, where pinned, the legacy tree's gas.
async function checkFamily(name, build, perElement) {
    const deltas = [];
    for (const n of SIZES) {
        const { on, off, delta } = await pair(build(n));
        const mainnet = await run(build(n), 'mainnet');
        assert.strictEqual(mainnet.success, true, mainnet.error);
        assert.strictEqual(mainnet.returnValue, off.returnValue);
        deltas.push(delta);
        assert.ok(delta >= perElement * n, `N=${n}: armed ${on.gasUsed}, unarmed ${off.gasUsed}`);
    }
    // Exactly linear: doubling N doubles the added gas.
    assert.strictEqual(deltas[2] - deltas[1], 2 * (deltas[1] - deltas[0]), `deltas ${deltas}`);
    if (LEGACY_GAS[name]) {
        const off = await runOff(build(100));
        const mainnet = await run(build(100), 'mainnet');
        assert.deepStrictEqual({ mainnet: mainnet.gasUsed, regtest: off.gasUsed }, LEGACY_GAS[name]);
    }
}

(XChainVM ? describe : describe.skip)('per-element metering gate: activation', function () {
    this.timeout(120000);

    it('resolves armed on regtest only, and the toggle used below really switches it', function () {
        assert.strictEqual(isPerElementMeterActive('regtest', 0), true);
        for (const network of ['mainnet', 'testnet', 'unknown', undefined]) {
            assert.strictEqual(isPerElementMeterActive(network, LATE.timestamp), false, String(network));
        }
        const saved = PER_ELEMENT_METER_ACTIVATION.regtest;
        PER_ELEMENT_METER_ACTIVATION.regtest = null;
        try { assert.strictEqual(isPerElementMeterActive('regtest', LATE.timestamp), false); }
        finally { PER_ELEMENT_METER_ACTIVATION.regtest = saved; }
    });

});

(XChainVM ? describe : describe.skip)('per-element metering gate: linear charge per family', function () {
    this.timeout(120000);
    for (const [name, [build, perElement]] of Object.entries(FAMILIES)) {
        it(`${name}: armed gas grows linearly with N, unarmed gas is unchanged`, async function () {
            await checkFamily(name, build, perElement);
        });
    }
});

(XChainVM ? describe : describe.skip)('per-element metering gate: charge boundaries', function () {
    this.timeout(120000);

    it('keeps the plain-Set charge for a real Set argument', async function () {
        const body = 'var a=new Set(), b=new Set(); for (var i=0;i<300;i++){a.add(i); b.add(i+1);} ' +
            'return a.union(b).size + a.intersection(b).size + (a.isSubsetOf(b) ? 1 : 0);';
        const { delta } = await pair(body);
        assert.strictEqual(delta, 0);
    });

    it('never charges a set-like less than its claimed size, and charges keys walked beyond it', async function () {
        const methods = ['union', 'intersection', 'difference', 'symmetricDifference',
            'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'];
        for (const n of [64, 256, 4096]) {
            for (const m of methods) {
                const honest = SEQ(n) + `var o={size:${n}, has:function(k){return k<${n};}, keys:function(){return big.values();}};` +
                    `var a=new Set([1,2,3]); var r=a.${m}(o); return typeof r === 'boolean' ? (r?1:0) : r.size;`;
                const { delta } = await pair(honest);
                assert.ok(delta >= 0, `${m} N=${n}: armed cheaper than unarmed by ${-delta}`);
            }
            const liar = SEQ(n) + 'var o={size:0, has:function(){return false;}, keys:function(){return big.values();}};' +
                'return new Set([-1]).union(o).size;';
            assert.ok((await pair(liar)).delta >= n, `size-0 set-like union N=${n}`);
        }
    });

    it('charges object spread and rest from the first key', async function () {
        for (const keys of [1, 2, 8, 255]) {
            assert.strictEqual((await pair(OBJ(keys) + 'var r = {...o}; return 1;')).delta, keys);
            assert.strictEqual((await pair(OBJ(keys) + 'var {k0, ...r} = o; return 1;')).delta, keys);
        }
        // Above the growth threshold both sides already charged every key.
        assert.strictEqual((await pair(OBJ(300) + 'var r = {...o}; return 1;')).delta, 0);
    });

    it('charges a for-of walk over an iterator helper per value yielded', async function () {
        const body = (n) => FILL(n) + 'var c=0; for (var v of big.values().take(1e9)) c+=v; return c;';
        const a = (await pair(body(100))).delta, b = (await pair(body(200))).delta;
        assert.strictEqual(b - a, 100);
    });
});

// Runs the body armed and unarmed on regtest and requires identical status, error and result.
// mainnet runs the bare natives, so it is the reference for read order and errors. The
// unarmed regtest run is compared too unless the legacy testnet/regtest Set wrapper is
// involved: that wrapper reads a set-like argument's size a second time, which the armed
// path does not. A receiver of a regtest-wrapped collection class names itself differently
// on mainnet, where that wrapper is off, so those cases compare to unarmed regtest only.
async function both(body, opts) {
    const on = await run(body, 'regtest');
    const refs = [];
    if (!(opts && opts.unarmedOnly)) refs.push(['mainnet', await run(body, 'mainnet')]);
    if (!(opts && opts.nativeOnly)) refs.push(['unarmed regtest', await runOff(body)]);
    for (const [label, ref] of refs) {
        assert.strictEqual(on.success, ref.success, `armed ${on.error} / ${label} ${ref.error}`);
        assert.strictEqual(on.error, ref.error, label);
        assert.strictEqual(on.returnValue, ref.returnValue, label);
    }
    return on;
}
const CATCH = (expr) => `try { return JSON.stringify(${expr}); } catch (e) { return e.name + ': ' + e.message; }`;

(XChainVM ? describe : describe.skip)('per-element metering gate: Set algebra behaviour is unchanged', function () {
    this.timeout(120000);

    it('set-like reads happen once, in spec order, with `this` bound to the argument', async function () {
        for (const m of ['union', 'intersection', 'difference', 'symmetricDifference',
            'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']) {
            for (const size of [1, 2, 10]) {
                const body = `var log=[]; var o={};
                    o = { get size(){ log.push('size'); return ${size}; },
                          get has(){ log.push('has'); return function(k){ log.push('has:'+k+':'+(this===o)); return k===1 || k===5; }; },
                          get keys(){ log.push('keys'); return function(){ log.push('keys:'+(this===o)); var it=[1,5,7].values();
                              return { get next(){ log.push('getnext'); return function(){ var r=it.next(); log.push('next:'+r.value); return r; }; },
                                       get return(){ log.push('getreturn'); return function(){ log.push('return'); return {}; }; } }; }; } };
                    var r = new Set([1,2,3]).${m}(o);
                    return JSON.stringify([r instanceof Set ? Array.from(r) : r, log]);`;
                const res = await both(body, { nativeOnly: true });
                assert.strictEqual(res.success, true, `${m}/${size}: ${res.error}`);
            }
        }
    });

    it('set-like validation errors are the native ones', async function () {
        const cases = [
            '{}', '{size: NaN, has: function(){}, keys: function(){}}', '{size: -1, has: function(){}, keys: function(){}}',
            '{size: 1, has: 1, keys: function(){}}', '{size: 1, has: function(){}, keys: 1}',
            '{size: 1, has: function(){}, keys: function(){ return 1; }}',
            '{size: 0, has: function(){}, keys: function(){ return {next: 1}; }}',
            '{size: 0, has: function(){}, keys: function(){ return {next: function(){ return 1; }}; }}',
            '{size: {valueOf: function(){ return 2; }}, has: function(k){ return k === 1; }, keys: function(){ return [1].values(); }}',
            'null', '5', 'new Map([[1, 2]])',
        ];
        for (const c of cases) {
            for (const m of ['union', 'isSupersetOf', 'intersection']) {
                await both(CATCH(`(function(){ var r = new Set([1,2]).${m}(${c}); return r instanceof Set ? Array.from(r) : r; })()`),
                    { nativeOnly: true });
            }
        }
        await both(CATCH('Set.prototype.union.call({}, new Set())'));
        await both(CATCH('Set.prototype.union.call(new Map(), new Set())'), { unarmedOnly: true });
    });
});

(XChainVM ? describe : describe.skip)('per-element metering gate: iterator and String.raw behaviour is unchanged', function () {
    this.timeout(120000);

    it('iterator helpers pass callbacks the native arguments and errors', async function () {
        const bodies = [
            CATCH('[5,6,7].values().map(function(){ return [arguments.length, arguments[0], arguments[1], this === undefined || this === globalThis]; }).toArray()'),
            CATCH('[5,6,7].values().reduce(function(){ return arguments.length + (arguments[0] | 0); })'),
            CATCH('[5,6,7].values().reduce(function(a, v, i){ return a + v * i; }, 100)'),
            CATCH('[].values().reduce(function(a, v){ return a + v; })'),
            CATCH('[1,2].values().map(1)'),
            CATCH('[1,2].values().filter()'),
            CATCH('Iterator.prototype.map.call(5, function(){})'),
            CATCH('[1,2,3].values().flatMap(function(v){ return [v, v]; }).toArray()'),
            CATCH('[1,2,3].values().flatMap(function(v){ return v; }).toArray()'),
            CATCH('[1,2,3,4].values().filter(function(v, i){ return i % 2; }).take(5).drop(0).toArray()'),
            CATCH('[1,2,3].values().find(function(v){ return v > 1; })'),
            CATCH('[1,2,3].values().some(function(v){ throw new RangeError("x" + v); })'),
            CATCH('(function(){ var h=[1,2].values().map(Math.abs); h.next(); return [h.next(), h.next(), h.next()]; })()'),
            CATCH('[1,2,3].values().map(Math.abs).next.call({})'),
        ];
        for (const b of bodies) await both(b);
    });

    it('String.raw keeps the native result, read order and errors', async function () {
        const bodies = [
            CATCH('String.raw({raw:["a","b","c"]}, 1, 2, 3)'),
            CATCH('String.raw({raw:["a","b","c"]}, 1)'),
            CATCH('String.raw({raw:"xyz"}, "-", "+")'),
            CATCH('String.raw({raw:{length:3, 0:"p"}}, "s")'),
            CATCH('String.raw({raw:{length:2.7, 0:"a", 1:"b"}}, "-")'),
            CATCH('String.raw({raw:{length:-4}})'),
            CATCH('String.raw({raw:[]})'),
            CATCH('String.raw({raw:[Symbol("s")]})'),
            CATCH('String.raw({raw:["a","b"]}, Symbol("s"))'),
            CATCH('String.raw({raw:["a","b"]}, {toString:function(){return "T";}, valueOf:function(){return "V";}})'),
            CATCH('String.raw()'), CATCH('String.raw(null)'), CATCH('String.raw({})'), CATCH('String.raw({raw:null})'),
            CATCH('(function(){ var x=4; return String.raw`a${x}\\\\n${x+1}`; })()'),
            `var log=[]; var t={ get raw(){ log.push('raw'); return { get length(){ log.push('length'); return 3; },
                get 0(){ log.push('0'); return 'a'; }, get 1(){ log.push('1'); return 'b'; }, get 2(){ log.push('2'); return 'c'; } }; } };
             var s1={toString:function(){ log.push('s1'); return '1'; }}, s2={toString:function(){ log.push('s2'); return '2'; }};
             var r=String.raw(t, s1, s2, {toString:function(){ log.push('s3'); return '3'; }}); return JSON.stringify([r, log]);`,
        ];
        for (const b of bodies) {
            const res = await both(b);
            assert.ok(res.success, res.error);
        }
    });
});
