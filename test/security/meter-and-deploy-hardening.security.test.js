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
 * Meter-evasion + deploy-validation hardening (regression locks)
 *
 * Pins two airtight-but-untested properties (pass-5 audit, 2026-07-06):
 *
 *  1. Gas-meter completeness. Every unbounded-work construct must terminate as
 *     out_of_gas or out_of_stack (deterministic), NEVER as a wall-clock timeout
 *     (which would be unmetered CPU: a throughput DoS + a wall-clock-dependent
 *     fork). Covers implicit-invocation paths that create NO CallExpression node
 *     (getters/setters/valueOf/toString/Symbol.toPrimitive), which are metered
 *     only via the FunctionExpression __gas + __depth_enter injection, plus
 *     empty-bodied loops (metered via ensureBlock) and aliased native scanners.
 *     These are NOT covered by native-dos.security.test.js.
 *
 *  2. Deploy-validation completeness. Banned dangerous constructs (BigInt/RegExp
 *     literals, the async surface in every position, the __gas identifier, banned
 *     Math transcendentals) are rejected by validateSyntax, benign look-alikes
 *     are NOT (no false positives), and the non-deterministic globals that are
 *     merely runtime-stripped (Math.random/Date/Function/eval/Proxy/process) are
 *     undefined inside the sandbox so a call throws rather than returning a
 *     fleet-forking value.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const ABOVE = { height: 2, timestamp: 1900000000, hash: 'b' };
const fn = (b) => `module.exports = function(xchain){ ${b} };`;

(XChainVM ? describe : describe.skip)('gas-meter completeness: no unmetered CPU path (pass-5 lock)', function () {
    this.timeout(30000);
    let vm;
    // Small ceiling + short wall-clock: a metered construct trips the ceiling well
    // before the wall-clock net; an UNMETERED one would time out instead.
    beforeEach(function () { vm = createVM({ maxCpuTimeMs: 2000, gasCeiling: 200000 }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });
    const run = (b) => execute(vm, fn(b), { method: 'default', blockContext: ABOVE });

    const mustGasBound = {
        'empty while(true)':            `while(true){}`,
        'empty for(;;)':                `for(;;){}`,
        'while(true) no-block':         `while(true);`,
        'do{}while(true)':              `do{}while(true);`,
        'labeled continue loop':        `outer: while(true){ continue outer; }`,
        'getter in tight loop':         `var o={get x(){ return 1; }}; for(var i=0;;i++){ o.x; }`,
        'custom iterator next() loop':  `var it={ [Symbol.iterator](){ return { next:function(){ return {value:0,done:false}; } }; } }; for(var v of it){}`,
        'aliased indexOf on 1e9 length':`return Array.prototype.indexOf.call({length:1e9}, 'z');`,
        'logical chain spin':           `var f=function(){return true;}; while(f() && f() && f()){}`,
        'try/catch spin':               `while(true){ try{ throw 1; }catch(e){} }`,
        'getter-throw catch spin':      `var o={get x(){ throw 1; }}; while(true){ try{ o.x; }catch(e){} }`,
    };
    for (const [name, body] of Object.entries(mustGasBound)) {
        it(`${name} => out_of_gas (metered, not timeout)`, async function () {
            const r = await run(body);
            assert.strictEqual(r.success, false);
            assert.match(r.error, /^out_of_gas:/, 'must be gas-bounded, got: ' + r.error);
        });
    }

    // Recursion through implicit-invocation paths (no CallExpression node) must hit
    // the deterministic __depth_enter guard (out_of_stack), not a native overflow.
    const mustStackBound = {
        'getter self-recursion':        `var o={get x(){ return o.x; }}; return o.x;`,
        'getter no-call self-read':     `var o={get x(){ var y=o.x; return y; }}; return o.x;`,
        'setter self-recursion':        `var o={set x(v){ o.x=v; }}; o.x=1; return 'x';`,
        'valueOf recursion':            `var o={valueOf:function(){ return o+0; }}; return o+0;`,
        'toString recursion':           `var o={toString:function(){ return ''+o; }}; return String(o);`,
        'Symbol.toPrimitive recursion': `var o={ [Symbol.toPrimitive]:function(){ return +o; } }; return +o;`,
        'mutual getter recursion':      `var a={get x(){ return b.x; }}, b={get x(){ return a.x; }}; return a.x;`,
    };
    for (const [name, body] of Object.entries(mustStackBound)) {
        it(`${name} => out_of_stack (depth-guarded, deterministic)`, async function () {
            const r = await run(body);
            assert.strictEqual(r.success, false);
            assert.match(r.error, /^out_of_stack:/, 'must be depth-bounded, got: ' + r.error);
        });
    }
});

(XChainVM ? describe : describe.skip)('deploy-validation + runtime-strip completeness (pass-5 lock)', function () {
    let vm;
    before(function () { if (!XChainVM) this.skip(); vm = createVM(); });
    const deployRejects = (code) => {
        const r = vm.validateSyntax(code, { enforceBannedAsync: true });
        return r && r.valid === false;
    };

    const banned = {
        'bigint literal':          `module.exports=function(){ return 10n; };`,
        'bigint hex literal':      `module.exports=function(){ return 0xffn; };`,
        'regex literal':           `module.exports=function(){ return /a+/.source; };`,
        'regex nested in array':   `module.exports=function(){ return [/a/,/b/][0]; };`,
        'async function':          `module.exports=async function(){ return 1; };`,
        'async arrow':             `module.exports=function(){}; var f=async()=>1;`,
        'async method shorthand':  `module.exports=function(){ return {async m(){ return 1; }}; };`,
        'async generator method':  `module.exports=function(){ return {async *m(){}}; };`,
        'await expression':        `module.exports=async function(){ return await 1; };`,
        'for-await':               `module.exports=async function(){ for await(var x of []){} };`,
        '__gas identifier':        `module.exports=function(){ __gas(1); return 1; };`,
        'Math.pow transcendental': `module.exports=function(){ return Math.pow(2,3); };`,
    };
    for (const [name, code] of Object.entries(banned)) {
        it(`rejects ${name} at deploy`, function () {
            assert.strictEqual(deployRejects(code), true);
        });
    }

    const benign = {
        'string containing "10n"': `module.exports=function(){ return "value 10n"; };`,
        'comment with 10n and /a/':`module.exports=function(){ /* 10n /a/ */ return 1; };`,
        'chained division':        `module.exports=function(){ var a=10,b=2; return a/b/1; };`,
        'identifier named getX':   `module.exports=function(){ var getX=1; return getX; };`,
        'xchain.math.pow':         `module.exports=function(x){ return x.math.pow('2','3'); };`,
        'normal state contract':   `module.exports=function(x){ x.state.set('k','1'); return x.state.get('k'); };`,
    };
    for (const [name, code] of Object.entries(benign)) {
        it(`does NOT reject benign: ${name}`, function () {
            assert.strictEqual(deployRejects(code), false);
        });
    }

    // Runtime-stripped non-deterministic / dangerous globals are undefined so a call
    // throws rather than returning a fleet-forking value.
    const runtimeUndefined = ['Math.random', 'Date', 'Function', 'eval', 'Proxy', 'Reflect', 'WeakRef'];
    for (const g of runtimeUndefined) {
        it(`runtime: ${g} is undefined inside the sandbox`, async function () {
            vm.beginBlock();
            const r = await execute(vm, fn(`return typeof ${g};`), { method: 'default', blockContext: ABOVE });
            vm.endBlock();
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(JSON.parse(r.returnValue), 'undefined');
        });
    }

    it('runtime: Math exposes only the deterministic whitelist', async function () {
        vm.beginBlock();
        const r = await execute(vm, fn(`return Object.keys(Math).sort().join(',');`), { method: 'default', blockContext: ABOVE });
        vm.endBlock();
        assert.strictEqual(JSON.parse(r.returnValue), 'E,PI,abs,ceil,floor,max,min,round,sign,trunc');
    });

    it('runtime: calling Math.random() throws (never returns a value)', async function () {
        vm.beginBlock();
        const r = await execute(vm, fn(`try{ return String(Math.random()); }catch(e){ return 'THREW'; }`), { method: 'default', blockContext: ABOVE });
        vm.endBlock();
        assert.strictEqual(JSON.parse(r.returnValue), 'THREW');
    });
});
