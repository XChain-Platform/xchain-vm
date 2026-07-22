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
 * Native-recursion structural-depth guard (F-NR)
 *
 * JSON.stringify and Array.prototype.join/flat (join also backs toString,
 * String(arr), arr + '' and template interpolation of an array) recurse in
 * native C++ down to the value's NESTING depth. That native recursion bypasses
 * the __depth_enter meter (which only wraps contract JS frames), so its only
 * backstop is V8's native stack limit -- which isolated-vm sets from the HOST
 * THREAD stack (512KB/pthread on macOS, ~2MB on Linux, ~128KB on musl). A
 * contract can build a spine past that depth with a cheap loop (a=[a]; a plain
 * loop, no recursion), feed it to one of these sinks, CATCH the RangeError, and
 * branch on caught-vs-not -> divergent hashed state on a heterogeneous-OS fleet.
 *
 * The guard pre-checks nesting depth against the platform-independent
 * __DEPTH_LIMIT and routes an over-depth value into the same un-swallowable
 * __stackPoison the contract-recursion guard uses, so the outcome is a
 * DETERMINISTIC out_of_stack on every host. It is CONSENSUS-GATED on the same
 * block-time flag-day as F3-binary/globals: below the gate the legacy
 * (catchable native overflow) behaviour replays unchanged.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const CEILING = 3000000;
const BELOW = { height: 100, timestamp: 1700000000, hash: 'abc' }; // < BINARY_ALLOC_GATE_BLOCK_TIME
const ABOVE = { height: 200, timestamp: 1900000000, hash: 'def' }; // >= gate

const fn = (body) => `module.exports = function(xchain){ ${body} };`;
const DEEP_ARR = `var a=[];for(var i=0;i<50000;i++){a=[a];}`;
const DEEP_OBJ = `var o={};for(var i=0;i<50000;i++){o={a:o};}`;

(XChainVM ? describe : describe.skip)('native-recursion structural-depth guard (F-NR)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM({ maxCpuTimeMs: 8000, gasCeiling: CEILING }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, block) => execute(vm, fn(body), { method: 'default', blockContext: block });

    // ---- Below the gate: legacy behaviour is preserved bit-for-bit (replay) ----
    it('below the gate, a native overflow is still a CATCHABLE RangeError (replay preserved)', async function () {
        const r = await run(DEEP_ARR + `try{JSON.stringify(a);return 'no-throw';}catch(e){return 'CAUGHT:'+e.name;}`, BELOW);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'CAUGHT:RangeError');
    });

    // ---- Above the gate: every native-recursion sink is an uncatchable out_of_stack ----
    const sinks = {
        'JSON.stringify (deep array)':  DEEP_ARR + `try{JSON.stringify(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'JSON.stringify (deep object)': DEEP_OBJ + `try{JSON.stringify(o);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'Array.prototype.join':         DEEP_ARR + `try{a.join();return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'Array.prototype.toString':     DEEP_ARR + `try{a.toString();return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'String(arr)':                  DEEP_ARR + `try{String(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'arr + empty string':           DEEP_ARR + `try{var x=a+'';return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'Array.prototype.flat':         DEEP_ARR + `try{a.flat(Infinity);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
    };
    for (const [name, body] of Object.entries(sinks)) {
        it(`above the gate, ${name} is an uncatchable deterministic out_of_stack`, async function () {
            const r = await run(body, ABOVE);
            assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
            assert.match(r.error, /^out_of_stack:/, r.error);
            assert.strictEqual(r.returnValue, null, 'catch block must not be reachable (poison re-throws at __gas)');
            assert.strictEqual(r.gasUsed, CEILING, 'resource-fault gasUsed clamps to the ceiling (fee-bounded, hashed)');
        });
    }

    // ---- Above the gate: an aliased DAG that unfolds exponentially is a
    //      deterministic out_of_gas (bounded, not a hang), not a host-timing race. ----
    it('above the gate, an aliased DAG (a=[a,a]) is a deterministic out_of_gas, not a hang', async function () {
        const t0 = Date.now();
        const r = await run(`var a=[];for(var i=0;i<40;i++){a=[a,a];} try{JSON.stringify(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`, ABOVE);
        assert.strictEqual(r.success, false);
        assert.match(r.error, /^out_of_gas:/, r.error);
        assert.ok(Date.now() - t0 < 5000, 'must be gas-bounded, not spin to the wall-clock net');
    });

    // ---- Above the gate: legitimate shallow structures are untouched (no false poison) ----
    it('above the gate, shallow structures still serialize (no false poison)', async function () {
        const r = await run(`return JSON.stringify({a:1,b:[1,2,3],c:{d:'x'}});`, ABOVE);
        assert.strictEqual(r.success, true, r.error);
        assert.deepStrictEqual(JSON.parse(JSON.parse(r.returnValue)), { a: 1, b: [1, 2, 3], c: { d: 'x' } });
    });

    it('above the gate, small join/flat are cheap and correct', async function () {
        const r1 = await run(`return [1,2,3,4,5].join(',');`, ABOVE);
        assert.strictEqual(JSON.parse(r1.returnValue), '1,2,3,4,5');
        assert.ok(r1.gasUsed < 1000, 'small join must stay cheap: ' + r1.gasUsed);
        const r2 = await run(`return JSON.stringify([1,[2,[3]]].flat(Infinity));`, ABOVE);
        assert.deepStrictEqual(JSON.parse(JSON.parse(r2.returnValue)), [1, 2, 3]);
    });

    // ---- The poison boundary sits exactly at the platform-independent limit ----
    it('above the gate, a spine just UNDER the depth limit serializes; just OVER faults deterministically', async function () {
        // MAX_STACK_DEPTH default is 512. depth 400 (< limit) succeeds; 600 (> limit) faults.
        const under = await run(`var a=1;for(var i=0;i<400;i++){a=[a];} return JSON.stringify(a).length > 0 ? 'ok' : 'bad';`, ABOVE);
        assert.strictEqual(under.success, true, under.error);
        assert.strictEqual(JSON.parse(under.returnValue), 'ok');

        const over = await run(`var a=1;for(var i=0;i<600;i++){a=[a];} try{JSON.stringify(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`, ABOVE);
        assert.strictEqual(over.success, false);
        assert.match(over.error, /^out_of_stack:/, over.error);
    });

    // ---- Deserialization half of the same fork class: JSON.parse (2715) ----
    //
    // The parse sink recurses natively in the REVIVER walk
    // (InternalizeJSONProperty), whose overflow point is the host thread stack:
    // measured on Node 22, JSON.parse(deep, fn) throws a catchable RangeError
    // past depth ~290 on a 128KB stack, ~1200 on 512KB, ~4800 on 2MB. The guard
    // bounds the NESTING of the input text before the native parser sees it, so
    // the outcome is the same un-swallowable out_of_stack on every host.
    const DEEP_TEXT = `var t='['.repeat(50000)+']'.repeat(50000);`;

    it('below the gate, a deep JSON.parse reviver walk is still a CATCHABLE RangeError (replay preserved)', async function () {
        const r = await run(DEEP_TEXT + `try{JSON.parse(t,function(k,v){return v;});return 'no-throw';}catch(e){return 'CAUGHT:'+e.name;}`, BELOW);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'CAUGHT:RangeError');
    });

    const parseSinks = {
        'JSON.parse (no reviver)':      DEEP_TEXT + `try{JSON.parse(t);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'JSON.parse (reviver walk)':    DEEP_TEXT + `try{JSON.parse(t,function(k,v){return v;});return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'JSON.parse (deep objects)':    `var t='{"a":'.repeat(50000)+'1'+'}'.repeat(50000);try{JSON.parse(t);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
        'JSON.parse (ToString coerce)': DEEP_TEXT + `var o={toString:function(){return t;}};try{JSON.parse(o);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
    };
    for (const [name, body] of Object.entries(parseSinks)) {
        it(`above the gate, ${name} is an uncatchable deterministic out_of_stack`, async function () {
            const r = await run(body, ABOVE);
            assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
            assert.match(r.error, /^out_of_stack:/, r.error);
            assert.strictEqual(r.returnValue, null, 'catch block must not be reachable (poison re-throws at __gas)');
            assert.strictEqual(r.gasUsed, CEILING, 'resource-fault gasUsed clamps to the ceiling (fee-bounded, hashed)');
        });
    }

    it('above the gate, brackets INSIDE a JSON string literal are data, not nesting (no false poison)', async function () {
        const r = await run(`var t='"'+'['.repeat(50000)+'"';return JSON.parse(t).length;`, ABOVE);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 50000);
    });

    it('above the gate, an escaped quote does not close the literal early (no false poison)', async function () {
        // ["a\"[[[...[", 1] where the escaped quote is data, so the brackets
        // after it are still inside the literal and real nesting is 1.
        const r = await run(String.raw`var t='["a\\"'+'['.repeat(50000)+'",1]';var v=JSON.parse(t);return v.length+':'+v[1];`, ABOVE);
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), '2:1');
    });

    it('above the gate, the parse boundary sits at the platform-independent limit', async function () {
        const under = await run(`var t='['.repeat(400)+']'.repeat(400);return JSON.parse(t).length===1?'ok':'bad';`, ABOVE);
        assert.strictEqual(under.success, true, under.error);
        assert.strictEqual(JSON.parse(under.returnValue), 'ok');

        const over = await run(`var t='['.repeat(600)+']'.repeat(600);try{JSON.parse(t);return 'no-throw';}catch(e){return 'SWALLOWED';}`, ABOVE);
        assert.strictEqual(over.success, false);
        assert.match(over.error, /^out_of_stack:/, over.error);
    });

    it('the guard adds no gas: an in-bounds parse costs exactly the same above and below the gate', async function () {
        const body = `var v=JSON.parse('{"a":[1,2,3],"b":{"c":"x"}}');return v.b.c;`;
        const below = await run(body, BELOW);
        const above = await run(body, ABOVE);
        assert.strictEqual(below.success, true, below.error);
        assert.strictEqual(above.success, true, above.error);
        assert.strictEqual(JSON.parse(above.returnValue), 'x');
        assert.strictEqual(above.gasUsed, below.gasUsed,
            'in-bounds parse must stay gas-identical across the flag day: ' + below.gasUsed + ' vs ' + above.gasUsed);
    });
});
