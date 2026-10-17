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
 * Native stack overflow is terminal and the same at every stack size.
 *
 * V8 raises a catchable RangeError when the native stack runs out, at a
 * point that moves with --stack-size, host stack use at entry, executor
 * mode and JIT tier. Before the native stack activation a contract could
 * catch it (or discard it from a finally) and commit how deep it got, and
 * large frames or long argument lists reached it before the depth counter,
 * so whether a run succeeded depended on the node.
 *
 * Armed (regtest), every probe must settle identically in child processes
 * at --stack-size 400, default, 600 and 2000, in both executors, and every
 * overflow probe must settle exactly like an uncaught overflow. The deepest
 * bounded recursion each frame shape reaches must be the same at 400 and
 * 2000, which shows the depth budget, not the native stack, stops it; the
 * contract-frame shapes must also match at 200 (2x headroom). The shapes
 * that end in a 250-deep native walk (join, JSON) are left out at 200: that
 * walk alone needs about 200 KB, a cost of the structural-depth bound and
 * not of this rule.
 *
 * Unarmed (mainnet, testnet), every contract-reachable function source, the
 * metering output and the settle of a probe that reads them must stay
 * byte-identical to the pre-activation values pinned below.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const XChainVM = require('../../src/index.js');
const { meterCode } = require('../../src/metering.js');
const { SLOTS_PER_UNIT, FIXED_SLOTS } = require('../../src/metering/frame_weight.js');
const { NATIVE_STACK_LINE, ARGS_PER_UNIT, CALL_UNITS, BOUND_ARGS_MAX } = require('../../src/index/native_stack/harness_hooks.js');

const MATRIX_RUNNER = path.join(__dirname, 'helpers', 'native_stack_matrix_runner.js');
const REACH_RUNNER = path.join(__dirname, 'helpers', 'native_stack_reach_runner.js');

// Run a helper in a child node at a given --stack-size (null for the default).
function runChild(script, stackSize, args) {
    const argv = (stackSize ? ['--stack-size=' + stackSize] : []).concat([script]).concat(args);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, argv, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error('child at stack size ' + stackSize + ' exited ' + code + ': ' + err));
            try { resolve(JSON.parse(out.trim().split('\n').pop()).results); }
            catch (e) { reject(new Error('unparseable child output: ' + out + err)); }
        });
    });
}

// Reads the transformed source of contract functions with try, catch and
// finally, and every harness hook the activation can swap, by String(fn).
const PROBE = 'module.exports = function(xchain) {\n' +
    '  function f(a) { try { return a.x; } catch (e) { return 1; } finally { a = 0; } }\n' +
    '  function g(b) { try { return b; } finally { b = 2; } }\n' +
    '  function h() { try { throw 1; } catch { return 2; } }\n' +
    '  function k() { try { throw { m: 3 }; } catch ({ m }) { return m; } }\n' +
    '  function s() { var a = [1, 2]; return Math.max(...a) + [...a].length; }\n' +
    '  var G = (function () { return this; })();\n' +
    '  var pick = function (n) { try { return String(G[n]); } catch (e) { return "ERR"; } };\n' +
    '  return JSON.stringify({ f: String(f), g: String(g), h: String(h), k: String(k), s: String(s),\n' +
    '    apply: String(f.apply), bind: String(f.bind), call: String(f.call),\n' +
    '    gas: pick("__gas"), de: pick("__depth_enter"), dx: pick("__depth_exit"), as: pick("__arrspread"),\n' +
    '    run: [f(null), g(1), h(), k(), s()] });\n' +
    '};';
// Captured from the pre-activation tree: gasUsed and sha256 of the returned text.
const PINNED = {
    mainnet: { height: 970000, gasUsed: 6088, sha256: 'aa90801bb2b0b0ecb54b98f24c41869c87321c8fb30c4448e86b5c0696280064' },
    // Just below the v0.24.0 testnet arms (BTC 156908, change instant 1792303200); every earlier testnet gate is armed here.
    testnet: { height: 156907, timestamp: 1792303199, gasUsed: 6450, sha256: 'b4aa21d6a9181a3c2a43546cb7bb0741660f597cebedf653117b854f262ba1f7' },
};
const METER_PINNED = {
    'false,false,false': 'f493c13cfe7930e0847f014695417deb506df766f5da68aa69859bdd49392b52',
    'true,true,false': '5bb979c50e1bca020b36b16c43ae2be257e10128ebc4472153ca1e8d185120e7',
    'true,true,true': '5bb979c50e1bca020b36b16c43ae2be257e10128ebc4472153ca1e8d185120e7',
};

const OUT_OF_STACK = [false, 'out_of_stack: maximum call depth exceeded', 1000000, null, []];
// Probes that must succeed; every other probe overflows the native stack somewhere.
const ORDINARY = new Set(['shallowFat', 'smallApply', 'ordinaryCatch']);

const GAS = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100, VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

async function runProbe(network) {
    const vm = new XChainVM({ execution: 'in-process', gasSchedule: GAS, gasCeiling: 1000000,
        limits: { maxCpuTimeMs: 30000, maxMemory: 8 } });
    vm.beginBlock();
    const r = await vm.execute({ code: PROBE, state: {}, method: 'default', params: [], caller: 'c',
        contractAddress: 'C:BTC:7', contractIndex: 7, txHash: 'f'.repeat(64),
        blockContext: { height: PINNED[network].height, timestamp: PINNED[network].timestamp || 1795000000, hash: 'h' }, network });
    vm.endBlock();
    await vm.shutdown();
    return r;
}

describe('determinism: native stack overflow is terminal at every stack size (armed, regtest)', function () {
    this.timeout(600000);

    it('settles every probe identically at --stack-size 400, default, 600 and 2000, both executors, cold and warm', async function () {
        const sizes = [400, null, 600, 2000];
        const runs = await Promise.all(sizes.map((s) => runChild(MATRIX_RUNNER, s, ['regtest', '3'])));
        const keys = Object.keys(runs[0]);
        assert.ok(keys.length >= 30, 'the runner reported every probe in both executors');
        for (const key of keys) {
            const expected = JSON.stringify(runs[0][key]);
            runs.forEach((r, i) => assert.strictEqual(JSON.stringify(r[key]), expected,
                key + ' differs at stack size ' + (sizes[i] || 'default')));
            const probe = key.slice(key.indexOf('.') + 1);
            if (ORDINARY.has(probe)) assert.strictEqual(runs[0][key][0], true, key + ' must succeed');
            else assert.deepStrictEqual(runs[0][key], OUT_OF_STACK, key + ' must settle as an uncaught overflow');
        }
    });

    it('reaches the same bounded recursion depth for every frame shape at 400 and 2000, and at 200 for contract frames', async function () {
        const sizes = [200, 400, 2000];
        const runs = await Promise.all(sizes.map((s) => runChild(REACH_RUNNER, s, ['regtest'])));
        for (const key of Object.keys(runs[2])) {
            assert.ok(runs[2][key].reach > 0, key + ' recurses at least once');
            runs.forEach((r, i) => {
                if (sizes[i] === 200 && /AtTop$/.test(key)) return;
                assert.deepStrictEqual(r[key], runs[2][key], key + ' reaches a different depth at stack size ' + sizes[i]);
            });
        }
    });
});

describe('determinism: native stack activation unarmed (mainnet, testnet) leaves contract-visible source unchanged', function () {
    this.timeout(120000);

    for (const network of Object.keys(PINNED)) {
        it(network + ': String(fn) of contract functions and harness hooks matches the pinned source', async function () {
            const r = await runProbe(network);
            assert.strictEqual(r.success, true, String(r.error));
            assert.strictEqual(r.gasUsed, PINNED[network].gasUsed);
            assert.strictEqual(crypto.createHash('sha256').update(r.returnValue).digest('hex'),
                PINNED[network].sha256, 'contract-visible source moved: ' + r.returnValue);
        });
    }

    it('meterCode output with the activation off is byte-identical to the pinned transform', function () {
        for (const flags of Object.keys(METER_PINNED)) {
            const [specEvalOrder, meterCallSpread, meterRestPattern] = flags.split(',').map((x) => x === 'true');
            for (const nativeStackTerminal of [undefined, false]) {
                const out = meterCode(PROBE, { specEvalOrder, meterCallSpread, meterRestPattern, nativeStackTerminal });
                assert.strictEqual(crypto.createHash('sha256').update(out).digest('hex'), METER_PINNED[flags], flags);
            }
        }
    });
});

describe('consensus parameters: native stack terminal activation', function () {
    it('the depth-budget constants are frozen', function () {
        assert.deepStrictEqual({ SLOTS_PER_UNIT, FIXED_SLOTS }, { SLOTS_PER_UNIT: 32, FIXED_SLOTS: 8 });
        assert.deepStrictEqual({ ARGS_PER_UNIT, CALL_UNITS, BOUND_ARGS_MAX },
            { ARGS_PER_UNIT: 64, CALL_UNITS: 2, BOUND_ARGS_MAX: 16 });
        // The armed budget is the structural-depth bound, at most the musl-safe 256.
        assert.match(NATIVE_STACK_LINE, /__stackDepth \+ u > __NR_DEPTH_LIMIT/);
        assert.strictEqual(XChainVM.MAX_STACK_DEPTH_MUSL, 256);
    });

    it('NATIVE_STACK_TERMINAL_ACTIVATION is frozen, unarmed on mainnet, and armed on testnet at its v0.24.0 heights', function () {
        assert.deepStrictEqual(XChainVM.NATIVE_STACK_TERMINAL_ACTIVATION, {
            'BTC:mainnet': null,
            'LTC:mainnet': null,
            'DOGE:mainnet': null,
            'BTC:testnet': 156908,
            'LTC:testnet': 4927400,
            'DOGE:testnet': 68005165,
        });
        assert.ok(Object.isFrozen(XChainVM.NATIVE_STACK_TERMINAL_ACTIVATION));
        assert.strictEqual(XChainVM.isNativeStackTerminalActive('regtest', 'BTC', 0), true);
        for (const network of ['mainnet', 'unknown', undefined]) {
            assert.strictEqual(XChainVM.isNativeStackTerminalActive(network, 'BTC', 99999999), false, String(network));
        }
        assert.strictEqual(XChainVM.isNativeStackTerminalActive('testnet', 'BTC', 156907), false, 'testnet below');
        assert.strictEqual(XChainVM.isNativeStackTerminalActive('testnet', 'BTC', 156908), true, 'testnet at');
    });
});
