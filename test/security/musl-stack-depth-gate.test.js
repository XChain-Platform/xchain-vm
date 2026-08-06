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
 * Musl-safe recursion-bound HEIGHT gate 
 *
 * The injected __DEPTH_LIMIT (read by BOTH the intra-contract recursion guard
 * and the F-NR native-recursion guard) drops from MAX_STACK_DEPTH (512) to
 * MAX_STACK_DEPTH_MUSL (256) at/after the coordinated ~961000 block-HEIGHT
 * window. Below the window a musl/Alpine 128KB-stack validator's native
 * JSON.parse reviver walk (~292) and Array.prototype.join (~379) overflow BELOW
 * the 512 bound, so the guard's 512 pre-check never trips and a musl validator
 * forks from a glibc/macOS one. Lowering the bound to 256 makes the guard poison
 * (deterministic out_of_stack) before any host's native overflow, closing the
 * fork on musl too.
 *
 * This suite pins the gate BEHAVIOUR on both sides:
 *   - below the height: byte-identical to today (bound stays 512; a 300-deep
 *     spine serializes / recurses cleanly);
 *   - at/after the height: bound is 256 (a 300-deep spine faults out_of_stack, a
 *     200-deep one is untouched);
 *   - testnet/regtest: active from genesis (height 0);
 *   - the boundary sits exactly at 961000 on mainnet.
 *
 * The native-sink cases additionally require the F-NR guard active, which is
 * gated on BINARY_ALLOC_GATE_BLOCK_TIME (block TIME), so they use a post-gate
 * timestamp. The intra-contract recursion guard is NOT time-gated, so its cases
 * use a pre-F-NR timestamp to prove the HEIGHT gate moves it independently.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const CEILING = 3000000;

// Block time >= BINARY_ALLOC_GATE_BLOCK_TIME (1786060800): F-NR native guard ON.
const T_FNR_ON  = 1900000000;
// Block time < the F-NR gate: native guard OFF, but the intra-contract recursion
// guard (ungated) still enforces __DEPTH_LIMIT, so the HEIGHT gate is observable
// through recursion alone here.
const T_FNR_OFF = 1700000000;

// Heights straddling the 961000 mainnet activation.
const H_BELOW = 500000;
const H_AT    = 961000;
const H_JUST_BELOW = 960999;

const fn = (body) => `module.exports = function(xchain){ ${body} };`;

(XChainVM ? describe : describe.skip)('musl-safe recursion-bound HEIGHT gate ', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM({ maxCpuTimeMs: 8000, gasCeiling: CEILING }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (body, block, network) =>
        execute(vm, fn(body), { method: 'default', blockContext: block, network });

    // Depth 300 sits between MAX_STACK_DEPTH_MUSL (256) and MAX_STACK_DEPTH (512):
    // legal below the height gate, over-depth at/after it.
    const SPINE_300 = `var a=1;for(var i=0;i<300;i++){a=[a];}`;
    const SPINE_200 = `var a=1;for(var i=0;i<200;i++){a=[a];}`;
    // Recursion helper: r(n) recurses n frames deep.
    const RECURSE = `function r(n){ if(n<=0){ return 0; } return 1+r(n-1); }`;

    // ---- Native JSON sinks: an ACTIVE guard is clamped to the musl-safe bound even
    //      below the height gate, so the two flag-days cannot order into a fork ----
    // Below the height gate the intra-contract bound is still 512 (proven by the last
    // case in this block), but the F-NR sinks read the clamped
    // min(__DEPTH_LIMIT, MAX_STACK_DEPTH_MUSL). Without the clamp, a coin reaching the
    // block-TIME gate before its per-coin block-HEIGHT gate would hand a 293..512-deep
    // value to the native parser, which overflows on musl (~292) and succeeds on glibc.
    it('below the height gate, an active native guard still poisons a 300-deep JSON.stringify (clamped to 256)', async function () {
        const r = await run(SPINE_300 + `try{JSON.stringify(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
            { height: H_BELOW, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_stack:/, r.error);
        assert.strictEqual(r.returnValue, null, 'poison must be un-swallowable');
    });

    it('below the height gate, an active native guard still poisons a 300-deep JSON.parse (clamped to 256)', async function () {
        const r = await run(`var t='['.repeat(300)+']'.repeat(300);try{JSON.parse(t);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
            { height: H_BELOW, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_stack:/, r.error);
        assert.strictEqual(r.returnValue, null, 'poison must be un-swallowable');
    });

    it('below the height gate, a 200-deep spine (< 256) still serializes under an active guard', async function () {
        const r = await run(SPINE_200 + `return JSON.stringify(a).length > 0 ? 'ok' : 'bad';`,
            { height: H_BELOW, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'ok');
    });

    it('below the height gate, the intra-contract bound stays 512 while the native sinks are clamped', async function () {
        const r = await run(RECURSE + `return r(300);`, { height: H_BELOW, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 300);
    });

    // ---- Native JSON sinks: at/after the height gate, the 256 bound poisons ----
    it('at the height gate, a 300-deep JSON.stringify is a deterministic out_of_stack (bound is 256)', async function () {
        const r = await run(SPINE_300 + `try{JSON.stringify(a);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
            { height: H_AT, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_stack:/, r.error);
        assert.strictEqual(r.returnValue, null, 'poison must be un-swallowable');
        assert.strictEqual(r.gasUsed, CEILING, 'resource fault clamps gasUsed to the ceiling');
    });

    it('at the height gate, a 300-deep JSON.parse reviver walk is a deterministic out_of_stack (bound is 256)', async function () {
        const r = await run(`var t='['.repeat(300)+']'.repeat(300);try{JSON.parse(t);return 'no-throw';}catch(e){return 'SWALLOWED';}`,
            { height: H_AT, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_stack:/, r.error);
        assert.strictEqual(r.returnValue, null, 'poison must be un-swallowable');
    });

    it('at the height gate, a 200-deep spine (< 256) still serializes (no false poison)', async function () {
        const r = await run(SPINE_200 + `return JSON.stringify(a).length > 0 ? 'ok' : 'bad';`,
            { height: H_AT, timestamp: T_FNR_ON, hash: 'h' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'ok');
    });

    // ---- Intra-contract recursion guard (ungated by time): the HEIGHT gate alone
    //      moves it, proven with a PRE-F-NR timestamp. ----
    it('below the height gate, recursion 300 deep succeeds (bound stays 512, time pre-F-NR)', async function () {
        const r = await run(RECURSE + `return r(300);`, { height: H_BELOW, timestamp: T_FNR_OFF, hash: 'h' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 300);
    });

    it('at the height gate, recursion 300 deep is a deterministic out_of_stack (bound is 256, time pre-F-NR)', async function () {
        const r = await run(RECURSE + `try{return r(300);}catch(e){return 'SWALLOWED';}`,
            { height: H_AT, timestamp: T_FNR_OFF, hash: 'h' });
        assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_stack:/, r.error);
        assert.strictEqual(r.returnValue, null, 'poison must be un-swallowable');
    });

    it('at the height gate, recursion 200 deep (< 256) still succeeds (no false poison)', async function () {
        const r = await run(RECURSE + `return r(200);`, { height: H_AT, timestamp: T_FNR_OFF, hash: 'h' });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 200);
    });

    // ---- The boundary sits exactly at 961000 on mainnet ----
    it('the mainnet boundary is exactly 961000 (960999 keeps 512, 961000 drops to 256)', async function () {
        const below = await run(RECURSE + `return r(300);`, { height: H_JUST_BELOW, timestamp: T_FNR_OFF, hash: 'h' });
        assert.strictEqual(below.success, true, 'height 960999 must keep the 512 bound: ' + below.error);
        assert.strictEqual(JSON.parse(below.returnValue), 300);

        const at = await run(RECURSE + `try{return r(300);}catch(e){return 'SWALLOWED';}`,
            { height: H_AT, timestamp: T_FNR_OFF, hash: 'h' });
        assert.strictEqual(at.success, false, 'height 961000 must drop to the 256 bound');
        assert.match(at.error, /^out_of_stack:/, at.error);
    });

    // ---- testnet/regtest activate from genesis (no pre-activation history) ----
    for (const network of ['testnet', 'regtest']) {
        it(`${network} activates the 256 bound from genesis (height 0): recursion 300 out_of_stacks`, async function () {
            const r = await run(RECURSE + `try{return r(300);}catch(e){return 'SWALLOWED';}`,
                { height: 0, timestamp: T_FNR_OFF, hash: 'h' }, network);
            assert.strictEqual(r.success, false, 'must fail: ' + JSON.stringify(r.returnValue));
            assert.match(r.error, /^out_of_stack:/, r.error);
        });

        it(`${network} at genesis still runs a 200-deep recursion (< 256, no false poison)`, async function () {
            const r = await run(RECURSE + `return r(200);`, { height: 0, timestamp: T_FNR_OFF, hash: 'h' }, network);
            assert.strictEqual(r.success, true, r.error);
            assert.strictEqual(JSON.parse(r.returnValue), 200);
        });
    }
});
