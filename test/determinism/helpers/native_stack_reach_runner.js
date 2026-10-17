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
 * Child-process runner: the deepest bounded recursion each frame shape can
 * reach before it settles out_of_stack.
 *
 * Every shape recurses to an exact depth and returns. A bisection over
 * separate executions finds the deepest depth that still succeeds. When the
 * depth budget, not the native stack, is what stops the recursion, that
 * depth is the same at every --stack-size; the parent test compares the
 * smallest supported stack against a large one.
 *
 * Usage: node [--stack-size=K] native_stack_reach_runner.js <network> [shape,...]
 ********************************************************************/
// @ts-nocheck
'use strict';

const XChainVM = require('../../../src/index.js');

const GAS = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100, VM_ORACLE_READ: 100,
    VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};
const CONFIG = {
    gasSchedule: GAS, gasCeiling: 50000000,
    limits: { maxCpuTimeMs: 30000, maxMemory: 64, maxCodeSize: 65536 }
};

const locals = (k) => Array.from({ length: k }, (_, i) => 'var v' + i + ' = n + ' + i + ';').join(' ');
const list = (k, item) => Array.from({ length: k }, () => item).join(', ');
const nest = (k) => '['.repeat(k) + ']'.repeat(k);

// Each shape defines r(n), which must recurse to depth D (the injected number)
// through its own kind of frame and return a number.
const SHAPES = {
    plain: 'function r(n){ if (n >= D) return n; return r(n + 1); }',
    locals40: 'function r(n){ ' + locals(40) + ' if (n >= D) return n; return r(n + 1) + v0 + v39; }',
    locals800: 'function r(n){ ' + locals(800) + ' if (n >= D) return n; return r(n + 1) + v0 + v799; }',
    locals2500: 'function r(n){ ' + locals(2500) + ' if (n >= D) return n; return r(n + 1) + v0 + v2499; }',
    callArgs: 'function g(){ return 0; } function r(n){ if (n >= D) return n; g(' + list(1500, 'n') + '); return r(n + 1); }',
    nestedCalls: 'function g(a, b, c){ return 0; } function r(n){ if (n >= D) return n; ' +
        'var x = ' + 'g(n, n, '.repeat(30) + 'n' + ')'.repeat(30) + '; return r(n + 1) + x; }',
    arrayLiteral: 'function r(n){ if (n >= D) return n; var a = [' + list(2000, 'n') + ']; return r(n + 1) + a.length; }',
    viaForEach: 'function r(n){ if (n >= D) return n; var out = 0; [0].forEach(function(){ out = r(n + 1); }); return out; }',
    viaSort: 'function r(n){ if (n >= D) return n; var out = 0; [2, 1].sort(function(a, b){ if (!out) out = r(n + 1); return a - b; }); return out; }',
    viaGetter: 'function r(n){ if (n >= D) return n; return ({ get x(){ return r(n + 1); } }).x; }',
    viaToString: 'function r(n){ if (n >= D) return n; var s = "" + { toString: function(){ return String(r(n + 1)); } }; return s.length; }',
    viaReplace: 'function r(n){ if (n >= D) return n; var out = 0; "a".replace("a", function(){ out = r(n + 1); return ""; }); return out; }',
    viaArrayFrom: 'function r(n){ if (n >= D) return n; return Array.from([0], function(){ return r(n + 1); })[0]; }',
    viaReviver: 'function r(n){ if (n >= D) return n; var out = 0; JSON.parse("1", function(k, v){ out = r(n + 1); return v; }); return out; }',
    viaCall: 'function r(n){ if (n >= D) return n; return r.call(null, n + 1); }',
    viaStringify: 'function r(n){ if (n >= D) return n; var out = 0; JSON.stringify({ toJSON: function(){ out = r(n + 1); return 1; } }); return out; }',
    viaReduce: 'function r(n){ if (n >= D) return n; return [0].reduce(function(){ return r(n + 1); }, 0); }',
    viaFlatMap: 'function r(n){ if (n >= D) return n; return [0].flatMap(function(){ return [r(n + 1)]; })[0]; }',
    viaApply: 'var big = []; for (var i = 0; i < 1000; i++) big.push(0); ' +
        'function r(n){ if (n >= D) return n; big[0] = n + 1; return r.apply(null, big); }',
    viaSpread: 'var big = []; for (var i = 0; i < 1000; i++) big.push(0); ' +
        'function r(n){ if (n >= D) return n; var a = big.slice(); a[0] = n + 1; return r(...a); }',
    viaBound: 'function s(' + list(15, 'p').split(', ').map(function (p, i) { return p + i; }).join(', ') + ', n){ if (n >= D) return n; ' +
        'var b = s.bind(null, ' + list(15, '0') + '); return b(n + 1); } function r(n){ return s(' + list(15, '0') + ', n); }',
    joinAtTop: 'var deep = 1; for (var i = 0; i < 250; i++) deep = [deep]; function r(n){ if (n >= D) return deep.join(",").length; return r(n + 1); }',
    reviverAtTop: 'var t = "[".repeat(250) + "]".repeat(250); function r(n){ if (n >= D) return JSON.parse(t, function(k, v){ return v; }).length; return r(n + 1); }',
    jsonAtTop: 'var deep = []; for (var i = 0; i < 200; i++) deep = [deep]; function r(n){ if (n >= D) return JSON.stringify(deep).length; return r(n + 1); }',
};

function contract(shape, depth) {
    return 'module.exports = function(xchain) { var D = ' + depth + '; ' + SHAPES[shape] + ' return r(0); };';
}

function opts(code, network) {
    return {
        code, state: {}, method: 'default', params: [], caller: 'bc1qcaller',
        contractAddress: 'C:BTC:7', contractIndex: 7, txHash: 'f'.repeat(64),
        blockContext: { height: 100, timestamp: 4000000000, hash: 'ab'.repeat(32) },
        network, callDepth: 0, actionIndex: 11, callPath: '', rootActionIndex: 3
    };
}

// The deepest depth in [0, 1024] that succeeds, and the settle of the first that does not.
async function reach(vm, shape, network) {
    let lo = 0, hi = 1024, fail = null;
    const first = await vm.execute(opts(contract(shape, 0), network));
    if (!first.success) return { reach: -1, fail: first.error };
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const r = await vm.execute(opts(contract(shape, mid), network));
        if (r.success) lo = mid; else { hi = mid; fail = r.error; }
    }
    return { reach: lo, fail };
}

async function main() {
    const network = process.argv[2] || 'regtest';
    const only = process.argv[3] ? process.argv[3].split(',') : Object.keys(SHAPES);
    const out = { execArgv: process.execArgv, results: {} };
    for (const mode of ['in-process', 'subprocess']) {
        const vm = new XChainVM(Object.assign({ execution: mode }, CONFIG));
        vm.beginBlock();
        for (const shape of only) out.results[mode + '.' + shape] = await reach(vm, shape, network);
        vm.endBlock();
        await vm.shutdown();
    }
    process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) {
    main().then(() => process.exit(0), (e) => { process.stderr.write(String(e && e.stack) + '\n'); process.exit(2); });
}

module.exports = { SHAPES };
