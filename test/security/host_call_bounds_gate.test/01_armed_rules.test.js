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
 * Host-call bounds gate (HOST_CALL_BOUNDS_ACTIVATION).
 *
 * Armed, three host-call boundary corrections hold:
 *   - a refused emit.execute, emit.crossExecute or attestation.request at the
 *     emission cap is not billed its reservation, prepay or request fee;
 *   - a cyclic value handed to JSON.stringify or a host call throws a catchable
 *     TypeError at bounded cost, on both the value-hook walk and the plain value
 *     guard, while a shared (acyclic) reference still serializes;
 *   - a host-call argument holds the same nesting depth a plain JSON.stringify
 *     of it does, and the one-level allowance never reaches a nested stringify.
 * Disarmed, every case replays the legacy result byte for byte.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const runtime = require('../../../src/index.js');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

const CEILING = 1000000;
const LATE = { height: 100, timestamp: 4000000000, hash: 'abc123' };
const fn = (body) => `module.exports = function(xchain) { ${body} };`;
const FILL = 'for (var i = 0; i < 50; i++) xchain.emit.broadcast({});';
// A plain loop, never recursion, so building the spine cannot itself trip a guard.
const spine = (d) => `var s = 1; for (var i = 0; i < ${d}; i++) s = [s];`;
const CYCLE_TEXT = 'Converting circular structure to JSON';

// Run with the gate entry for `network` set to `value`, restoring it afterwards.
async function withGate(network, value, body) {
    const map = runtime.HOST_CALL_BOUNDS_ACTIVATION;
    const saved = map[network];
    map[network] = value;
    try { return await body(); } finally { map[network] = saved; }
}

let vm;
const run = (body, network, extra) => execute(vm, fn(body), {
    method: 'default', network: network || 'regtest', blockContext: LATE, ...extra,
});
// regtest with the gate disarmed: the legacy rule on the same network.
const runLegacy = (body) => withGate('regtest', null, () => run(body, 'regtest'));
// mainnet with the gate armed: the plain value guard path, since the
// JSON.stringify value-hook gate is unarmed on mainnet.
const runGuardPath = (body) => withGate('mainnet', 0, () => run(body, 'mainnet'));

function registerCapTests() {
    describe('emission cap is checked before the charge', function () {
        const CASES = [
            ['emit.execute', "xchain.emit.execute({ contractIndex: 9, method: 'm', gasLimit: 400000 })", 400000],
            ['emit.crossExecute', "xchain.emit.crossExecute({ targetChain: 'LTC', contractIndex: 9, method: 'm', " +
                "gasLimit: 200000, callbackMethod: 'cb' })", 200000],
            ['attestation.request', "xchain.attestation.request('llm', 'p', 'cb', [])", 5000],
        ];
        const refusedBody = (call) => `${FILL} var m; try { ${call}; } catch (e) { m = e.message; } return m;`;
        const baseBody = `${FILL} var m; try { 1; } catch (e) { m = e.message; } return 'emission limit exceeded (50)';`;

        for (const [name, call, reserved] of CASES) {
            it(`${name}: a refused call at the cap is billed no reservation`, async function () {
                const base = await run(baseBody);
                const r = await run(refusedBody(call));
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, base.returnValue);
                assert.strictEqual(r.emittedActions.length, 50);
                assert.ok(r.gasUsed - base.gasUsed < 1000,
                    `${name} billed ${r.gasUsed - base.gasUsed} gas for an emission never queued`);
            });

            it(`${name}: disarmed, the legacy charge-then-refuse replays`, async function () {
                const base = await runLegacy(baseBody);
                const r = await runLegacy(refusedBody(call));
                assert.strictEqual(r.returnValue, base.returnValue);
                assert.ok(r.gasUsed - base.gasUsed >= reserved, `${r.gasUsed} vs ${base.gasUsed}`);
            });
        }

        it('a call below the cap is charged identically armed and disarmed', async function () {
            for (const [name, call] of CASES) {
                const body = `${call}; return 1;`;
                const armed = await run(body);
                const legacy = await runLegacy(body);
                assert.strictEqual(armed.success, true, `${name}: ${armed.error}`);
                assert.deepStrictEqual(armed, legacy, name);
            }
        });

        it('a validation error still wins over the cap for emit.execute', async function () {
            const r = await run(refusedBody("xchain.emit.execute({ contractIndex: 9, method: 'a|b', gasLimit: 400000 })"));
            assert.strictEqual(r.returnValue, '"emit.execute: method must not contain \\"|\\""');
        });
    });
}

function registerCycleTests() {
    describe('cyclic values throw a catchable TypeError', function () {
        const SELF = "var a = { text: 'x' }; a.self = a;";
        const DEEP = "var root = { n: 0 }, cur = root; for (var i = 1; i < 100; i++) { cur.next = { n: i }; cur = cur.next; } cur.back = root;";

        for (const [path, exec] of [['value-hook walk', null], ['plain value guard', 'guard']]) {
            const go = (body) => (exec ? runGuardPath(body) : run(body));

            it(`${path}: a caught cyclic emit argument resumes with a fixed message`, async function () {
                const r = await go(`${SELF} try { xchain.emit.broadcast(a); } catch (e) { return e.name + ':' + e.message; } return 1;`);
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, JSON.stringify('TypeError:' + CYCLE_TEXT));
                assert.ok(r.gasUsed < 1000, `gasUsed ${r.gasUsed}`);
                assert.strictEqual(r.emittedActions.length, 0);
            });

            it(`${path}: an uncaught cycle fails as an error, not out_of_stack at the ceiling`, async function () {
                const r = await go(`${SELF} xchain.emit.broadcast(a); return 1;`);
                assert.strictEqual(r.success, false);
                assert.strictEqual(r.error, 'error: ' + CYCLE_TEXT);
                assert.ok(r.gasUsed < 1000, `gasUsed ${r.gasUsed}`);
            });

            it(`${path}: JSON.stringify of a 100-node loop is caught`, async function () {
                const r = await go(`${DEEP} try { JSON.stringify(root); } catch (e) { return e.message; } return 1;`);
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, JSON.stringify(CYCLE_TEXT));
            });

            it(`${path}: a shared reference on two branches is not a cycle`, async function () {
                const body = "var x = [1, 2]; var d = { a: x, b: [x, x] }; xchain.emit.broadcast({ d: d }); return JSON.stringify(d);";
                const r = await go(body);
                assert.strictEqual(r.success, true, r.error);
                assert.strictEqual(r.returnValue, JSON.stringify('{"a":[1,2],"b":[[1,2],[1,2]]}'));
            });
        }
    });
}

function registerCycleScopeTests() {
    describe('cycle detection scope and legacy replay', function () {
        const SELF = "var a = { text: 'x' }; a.self = a;";

        it('a toJSON that hands back its own ancestor is a cycle', async function () {
            const r = await run("var o = { x: {} }; o.x.toJSON = function () { return o; }; " +
                "try { JSON.stringify(o); } catch (e) { return e.name; } return 1;");
            assert.strictEqual(r.returnValue, JSON.stringify('TypeError'));
        });

        it('acyclic values cost the same gas armed and disarmed', async function () {
            const body = "var x = [1, 2]; var d = { a: x, b: [x, x], c: { k: 'v' } }; " +
                "xchain.emit.broadcast({ d: d }); return JSON.stringify(d).length;";
            assert.deepStrictEqual(await run(body), await runLegacy(body));
        });

        it('join and flat over a cyclic array are left to their depth fault', async function () {
            for (const call of ['a.join()', 'a.flat()']) {
                const body = `var a = [1]; a.push(a); try { ${call}; } catch (e) { return 'caught'; } return 1;`;
                const armed = await run(body);
                assert.deepStrictEqual(armed, await runLegacy(body), call);
                assert.match(armed.error, /^out_of_stack:/, call);
            }
        });

        it('disarmed, a cyclic argument replays the legacy out_of_stack at the ceiling', async function () {
            const r = await runLegacy(`${SELF} try { xchain.emit.broadcast(a); } catch (e) { return 'caught'; } return 1;`);
            assert.strictEqual(r.success, false);
            assert.match(r.error, /^out_of_stack:/);
            assert.strictEqual(r.gasUsed, CEILING);
        });
    });
}

function registerDepthTests() {
    describe('host-call argument depth matches JSON.stringify', function () {
        const LIMIT = runtime.MAX_STACK_DEPTH_MUSL;
        // { a: spine(d) } nests d + 1 deep, so d = LIMIT - 1 sits exactly at the bound.
        const emitAt = (d) => `${spine(d)} xchain.emit.broadcast({ a: s }); return 1;`;
        const strAt = (d) => `${spine(d)} return JSON.stringify({ a: s }).length;`;

        for (const [path, exec] of [['value-hook walk', null], ['plain value guard', 'guard']]) {
            const go = (body) => (exec ? runGuardPath(body) : run(body));

            it(`${path}: an argument at the documented depth passes, one deeper faults`, async function () {
                const okEmit = await go(emitAt(LIMIT - 1));
                const okStr = await go(strAt(LIMIT - 1));
                assert.strictEqual(okEmit.success, true, okEmit.error);
                assert.strictEqual(okStr.success, true, okStr.error);
                assert.strictEqual(okEmit.emittedActions.length, 1);
                for (const body of [emitAt(LIMIT), strAt(LIMIT)]) {
                    const r = await go(body);
                    assert.strictEqual(r.success, false);
                    assert.match(r.error, /^out_of_stack:/);
                }
            });
        }

        it('a state value at the documented depth is stored', async function () {
            const r = await run(`${spine(LIMIT - 1)} xchain.state.set('k', s); return 1;`);
            assert.strictEqual(r.success, true, r.error);
        });

        it('the allowance does not reach a JSON.stringify run from a hook inside the argument', async function () {
            const r = await run(`${spine(LIMIT + 1)} var hook = { toJSON: function () { JSON.stringify(s); return 1; } }; ` +
                'xchain.emit.broadcast({ h: hook }); return 1;');
            assert.strictEqual(r.success, false);
            assert.match(r.error, /^out_of_stack:/);
        });

        it('disarmed, the argument array still costs one level', async function () {
            const r = await runLegacy(emitAt(LIMIT - 1));
            assert.strictEqual(r.success, false);
            assert.match(r.error, /^out_of_stack:/);
            assert.strictEqual(r.gasUsed, CEILING);
        });
    });
}

(XChainVM ? describe : describe.skip)('host-call bounds gate', function () {
    this.timeout(120000);
    beforeEach(function () { vm = createVM({ gasCeiling: CEILING }); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });
    registerCapTests();
    registerCycleTests();
    registerCycleScopeTests();
    registerDepthTests();
});
