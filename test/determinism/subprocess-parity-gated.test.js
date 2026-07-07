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
 * In-process vs subprocess parity ABOVE the flag-day gate (pass-6 lock)
 *
 * Production embedders run execution:'subprocess' (crash containment); tests and
 * lighter callers run 'in-process'. A mixed-mode fleet MUST agree on every
 * consensus-relevant field, or two operators fork. The existing
 * subprocess-parity.test.js pins subprocess output to the golden manifest, but
 * only at BLOCK.timestamp 1700000000 -- BELOW the F3/F-NR/F-MO/F-PS flag-day, so
 * the GATED behaviours are never exercised cross-mode.
 *
 * This suite runs each contract in BOTH modes at a timestamp ABOVE the gate and
 * asserts the results are identical after collapsing the resource-error family
 * (out_of_gas / timeout / out_of_memory / out_of_stack / out_of_resource -> one
 * status, exactly as the indexer hashes it). It exercises every gated fix plus
 * the IPC-serialization edge cases (numeric state key, unicode return, numeric
 * state values, oracle/balance/tokenInfo inputs) that cross the worker boundary.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const { GAS_SCHEDULE, DEFAULT_LIMITS, XChainVM } = require('../fuzz/harness');

const ABOVE = { height: 200, timestamp: 1900000000, hash: 'def' }; // >= BINARY_ALLOC_GATE_BLOCK_TIME
const BELOW = { height: 100, timestamp: 1700000000, hash: 'abc' }; // < gate
const fn = (b) => `module.exports = function(xchain){ ${b} };`;

// Collapse the resource-exhaustion family exactly like the indexer (which hashes
// ONE status for the whole family; WHICH ceiling fired is a host-timing race).
function collapse(err) {
    if (/^(out_of_gas|timeout|out_of_memory|out_of_stack|out_of_resource)\b/.test(String(err || '')))
        return 'out_of_resource';
    return err;
}
function digest(r) {
    return crypto.createHash('sha256').update(JSON.stringify({
        success: r.success, error: collapse(r.error), returnValue: r.returnValue,
        stateChanges: r.stateChanges, stateDeletes: r.stateDeletes,
        emittedActions: r.emittedActions, gasUsed: r.gasUsed
    })).digest('hex');
}

// [id, body, blockContext, extraOpts]
const CASES = [
    ['simple state+emit',      `xchain.state.set('k','1'); xchain.emit.send({destination:'d',tick:'T',quantity:'5'}); return xchain.state.get('k');`, ABOVE, {}],
    ['revert',                 `xchain.require(false,'nope'); return 1;`, ABOVE, {}],
    ['out_of_gas loop',        `while(true){}`, ABOVE, {}],
    ['out_of_stack recursion', `function f(){return f();} return f();`, ABOVE, {}],
    ['math small',             `return xchain.math.add('2','3');`, ABOVE, {}],
    ['F-MO pow big (gated)',   `return xchain.math.pow('10','10000000');`, ABOVE, {}],
    ['F-MO pow below gate',    `return xchain.math.pow('10','5000');`, BELOW, {}],
    ['F-NR deep stringify',    `var a=[];for(var i=0;i<50000;i++){a=[a];} try{JSON.stringify(a);return 'no';}catch(e){return 'c';}`, ABOVE, {}],
    ['F-PS nested proto',      `var n=JSON.parse('{"__proto__":{"e":1},"good":3}'); xchain.emit.broadcast({nested:n}); return 'd';`, ABOVE, {}],
    ['F-2 numeric state key',  `xchain.state.set(123,'v'); return String(xchain.state.get(123));`, ABOVE, {}],
    ['large return string',    `return 'x'.repeat(70000);`, ABOVE, {}],
    ['numeric state values',   `xchain.state.set('n', {a:1e21, b:0.1, c:-5}); return 'ok';`, ABOVE, {}],
    ['unicode return',         `return '\\u{1F600}\\u0000\\uD83D';`, ABOVE, {}],
    ['multi emit + delete',    `xchain.state.set('a','1'); xchain.state.set('b','2'); xchain.state.delete('a'); for(var i=0;i<3;i++) xchain.emit.mint({tick:'T',quantity:''+i}); return 'z';`, ABOVE, {}],
    ['oracle price',           `return JSON.stringify(xchain.oracle.getPrice('BTC/USD'));`, ABOVE, { oracleData: { prices: { 'BTC/USD': { price: '65123.45678', round: 7 } }, snapshotAge: 2 } }],
    ['getBalance',             `return xchain.getBalance('addrX','TICK');`, ABOVE, { balances: { addrX: { TICK: '1000.5' } } }],
    ['getTokenInfo',           `return JSON.stringify(xchain.getTokenInfo('TICK'));`, ABOVE, { tokenInfo: { TICK: { supply: '21000000', decimals: 8, divisible: true } } }],
    ['input params',           `return xchain.getInputParam(0)+'|'+xchain.getInputParamCount();`, ABOVE, { params: ['hello', 'world'] }],
    ['preloaded state',        `return xchain.state.get('pre');`, ABOVE, { state: { pre: '{"x":1}' } }],
];

(XChainVM ? describe : describe.skip)('in-process vs subprocess parity above the flag-day gate (F3/F-NR/F-MO/F-PS)', function () {
    this.timeout(40000);
    let ip, sp;

    before(function () {
        const cfg = { gasSchedule: GAS_SCHEDULE, gasCeiling: 1000000, limits: DEFAULT_LIMITS };
        ip = new XChainVM(Object.assign({ execution: 'in-process' }, cfg));
        sp = new XChainVM(Object.assign({ execution: 'subprocess' }, cfg));
        ip.beginBlock(); sp.beginBlock();
    });
    after(function () {
        try { ip.endBlock(); sp.endBlock(); } catch (e) {}
        if (sp && sp.shutdown) sp.shutdown();
    });

    const base = {
        state: {}, method: 'default', params: [], caller: 'a', contractAddress: 'C:BTC:1',
        contractIndex: 1, txHash: '00'.repeat(32), network: 'regtest', balances: {}, tokenInfo: {}
    };

    for (const [id, body, block, extra] of CASES) {
        it(`${id}: in-process result == subprocess result`, async function () {
            const opts = Object.assign({}, base, extra, { code: fn(body), blockContext: block });
            const rIp = await ip.execute(opts);
            const rSp = await sp.execute(opts);
            assert.strictEqual(digest(rIp), digest(rSp),
                'MODE DIVERGENCE\n  in-process: ' + JSON.stringify({ success: rIp.success, error: collapse(rIp.error), gasUsed: rIp.gasUsed, stateChanges: rIp.stateChanges, emittedActions: rIp.emittedActions }) +
                '\n  subprocess: ' + JSON.stringify({ success: rSp.success, error: collapse(rSp.error), gasUsed: rSp.gasUsed, stateChanges: rSp.stateChanges, emittedActions: rSp.emittedActions }));
        });
    }
});
