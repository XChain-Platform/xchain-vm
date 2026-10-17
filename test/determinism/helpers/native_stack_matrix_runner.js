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
 * Child-process runner for the native stack overflow matrix.
 *
 * Runs every probe contract in both executors and prints one JSON line of
 * settle tuples. The parent test spawns it under several --stack-size values,
 * because the native overflow point moves with the stack size while every
 * validator must still settle each probe identically.
 *
 * Each probe runs `reps` times per executor, so later runs see warmed-up JIT
 * tiers; every repetition must settle the same or the runner reports it.
 *
 * Usage: node [--stack-size=K] native_stack_matrix_runner.js <network> [reps] [case,...]
 ********************************************************************/
// @ts-nocheck
'use strict';

const XChainVM = require('../../../src/index.js');

const GAS = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100, VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const CONFIG = {
    gasSchedule: GAS, gasCeiling: 1000000,
    limits: { maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50, maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536 }
};

// Recursion with fat frames: n locals per call, so the native stack runs out in
// tens of frames, well below the deterministic depth counter.
const locals = (n) => Array.from({ length: n }, (_, i) => 'var v' + i + ' = n + ' + i + ';').join(' ');
const fat = (n) => 'function r(n){ ' + locals(n) + ' depth = n; return r(n + 1) + v0 + v' + (n - 1) + '; }';
const fatTo = (n, d) => 'function r(n){ ' + locals(n) + ' depth = n; if (n >= ' + d + ') return n; return r(n + 1) + v0 + v' + (n - 1) + '; }';
const wrap = (body) => 'module.exports = function(xchain) { ' + body + ' };';

const CASES = {
    // A contract records how deep it got, then catches the overflow.
    fatCatch800: wrap('var depth = 0; ' + fat(800) + ' try { r(0); } catch (e) { return [depth, String(e && e.name), String(e && e.message)]; }'),
    fatCatch2000: wrap('var depth = 0; ' + fat(2000) + ' try { r(0); } catch (e) { return [depth, String(e && e.name)]; }'),
    storeDepth: wrap('var depth = 0; ' + fat(800) + ' try { r(0); } catch (e) {} xchain.state.set("depth", depth); return depth;'),
    // No catch clause at all: a return in finally swallows the in-flight error.
    finallySwallow: wrap('var depth = 0; ' + fat(800) + ' function g(){ try { r(0); } finally { return depth; } } var d = g(); xchain.state.set("depth", d); return d;'),
    // A break in a finally inside a loop swallows it too.
    finallyBreak: wrap('var depth = 0; ' + fat(800) + ' for (;;) { try { r(0); } finally { break; } } return depth;'),
    // Optional catch binding.
    bareCatch: wrap('var depth = 0; ' + fat(800) + ' try { r(0); } catch { return depth; }'),
    // A destructuring default that throws would replace the overflow before the body runs.
    destructureCatch: wrap('var depth = 0; ' + fat(800) + ' try { try { r(0); } catch ({ zz = (function(){ throw 7; })() }) { return -1; } } catch (x) { return [x, depth]; }'),
    // The handler itself overflows, then a finally swallows that.
    handlerOverflowFinally: wrap('var depth = 0; ' + fat(800) + ' function g(){ try { throw 1; } catch (e) { r(0); } finally { return depth; } } return g();'),
    // Bounded fat recursion: deep enough to overflow natively at small stacks, not at large ones.
    boundedFat: wrap('var depth = 0; ' + fatTo(800, 100) + ' return r(0);'),
    // The depth hooks are reachable through the global object: calling the exit
    // hook by hand, or unwinding with a token the contract pushed itself, must not
    // lower the depth below a live frame.
    unwindByHand: wrap('var G = (function(){ return this; })(); var ex = G["__depth_exit"]; var depth = 0; ' +
        'function r(n){ for (var i = 0; i < 300; i++) ex(); ' + locals(800) + ' depth = n; if (n >= 100) return n; return r(n + 1) + v0 + v799; } return r(0);'),
    unwindOwnToken: wrap('var G = (function(){ return this; })(); var T = G["__depth_enter"](1); var depth = 0; ' +
        'function r(n){ ' + locals(800) + ' depth = n; if (n === 5) G["__depth_exit"](T, 0); if (n >= 100) return n; return r(n + 1) + v0 + v799; } return r(0);'),
    // Shallow fat recursion that fits everywhere must still succeed.
    shallowFat: wrap('var depth = 0; ' + fatTo(800, 4) + ' return r(0);'),
    // Native argument push: the largest Math.max.apply that fits depends on the stack.
    applyBisect: wrap('var a = new Array(130000); var lo = 50000, hi = 130000; ' +
        'while (hi - lo > 1000) { var mid = Math.floor((lo + hi) / 2); a.length = mid; var ok = true; ' +
        'try { Math.max.apply(null, a); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid; } ' +
        'xchain.state.set("maxArgs", lo); return lo;'),
    spreadBisect: wrap('var a = new Array(130000); var lo = 50000, hi = 130000; ' +
        'while (hi - lo > 1000) { var mid = Math.floor((lo + hi) / 2); a.length = mid; var ok = true; ' +
        'try { Math.max(...a); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid; } ' +
        'xchain.state.set("maxArgs", lo); return lo;'),
    // A small apply and spread stay ordinary calls.
    smallApply: wrap('var a = [3, 9, 4]; return Math.max.apply(null, a) + Math.max(...a);'),
    // Uncaught overflows: the reference settle every case above must match.
    fatUncaught: wrap(fat(800) + ' r(0);'),
    fatUncaughtAfterWrite: wrap('xchain.state.set("a", 1); ' + fat(800) + ' r(0);'),
    applyUncaught: wrap('var a = new Array(130000); return Math.max.apply(null, a);'),
    rethrowCaught: wrap(fat(800) + ' try { r(0); } catch (e) { throw e; }'),
    // An ordinary caught error keeps working.
    ordinaryCatch: wrap('try { null.x; } catch (e) { return String(e && e.name); }'),
};

function opts(code, network) {
    return {
        code, state: {}, method: 'default', params: [], caller: 'bc1qcaller',
        contractAddress: 'C:BTC:7', contractIndex: 7, txHash: 'f'.repeat(64),
        blockContext: { height: 100, timestamp: 4000000000, hash: 'ab'.repeat(32) },
        network, callDepth: 0, actionIndex: 11, callPath: '', rootActionIndex: 3
    };
}

async function main() {
    const network = process.argv[2] || 'regtest';
    const reps = Math.max(1, Number(process.argv[3]) || 1);
    const only = process.argv[4] ? process.argv[4].split(',') : Object.keys(CASES);
    const out = { execArgv: process.execArgv, results: {} };
    for (const mode of ['in-process', 'subprocess']) {
        const vm = new XChainVM(Object.assign({ execution: mode }, CONFIG));
        vm.beginBlock();
        for (const name of only) {
            const seen = new Set();
            let last = null;
            for (let i = 0; i < reps; i++) {
                const r = await vm.execute(opts(CASES[name], network));
                last = [r.success, r.error, r.gasUsed, r.returnValue, r.stateChanges];
                seen.add(JSON.stringify(last));
            }
            out.results[mode + '.' + name] = seen.size === 1 ? last : ['varies across repetitions', Array.from(seen)];
        }
        vm.endBlock();
        await vm.shutdown();
    }
    process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) {
    main().then(() => process.exit(0), (e) => { process.stderr.write(String(e && e.stack) + '\n'); process.exit(2); });
}

module.exports = { CASES };
