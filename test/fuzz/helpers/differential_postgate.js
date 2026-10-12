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
 * Post-gate differential profile.
 *
 * The legacy differential corpus runs at DEFAULT_BLOCK_CONTEXT with no
 * network: below BINARY_ALLOC_GATE_BLOCK_TIME and below the per-coin
 * musl-safe height gate, so the F-NR native guard is off and nothing nests
 * deeper than about 100. A musl leg there cannot see the fork the 256 bound
 * exists to prevent. This profile runs the same seeded corpus past both gates
 * on mainnet, then a fixed list of depth cases on mainnet and regtest:
 *   - each native-recursive sink at 200, its exact accepted maximum, one past
 *     it, 300 and 400;
 *   - composite cases, contract recursion then a native walk from the deepest
 *     frame, because both share one thread stack.
 * Above the bound a guard poison and a native overflow hash the same, so a
 * shrinking musl margin only shows AT the bound, where every leg must succeed.
 *
 * The regime check refuses a run where a one-past-the-maximum case did not
 * fault, which is what a pass silently back in the pre-gate regime looks like.
 ********************************************************************/
// @ts-nocheck

const { DEFAULT_SEED, DEFAULT_CASES, buildCorpus, runCorpus, platformTag } = require('./differential.js');
const { BINARY_ALLOC_GATE_BLOCK_TIME } = require('../../../src/index/runtime/activations.js');
const { PKG3_SANDBOX_ACTIVATION, isPkg3SandboxActive } = require('../../../src/index/runtime/activation_heights.js');

const POST_GATE_BLOCK = Object.freeze({
    height:    PKG3_SANDBOX_ACTIVATION['BTC:mainnet'] + 1000,
    timestamp: BINARY_ALLOC_GATE_BLOCK_TIME + 30 * 86400,
    hash:      'abc123'
});
const TARGETED_NETWORKS = Object.freeze({ mainnet: 1000000, regtest: 2000000 });

// Deepest nesting each sink accepts past both gates, measured on a glibc host
// and pinned by the post-gate block in test/fuzz/differential.fuzz.js. The
// object spine and the recursion helper spend one level on their own frame.
const SINK_MAX = Object.freeze({
    recurse:      254,
    parse:        256,
    parseReviver: 256,
    stringifyArr: 256,
    stringifyObj: 255,
    join:         256,
    string:       256,
    flat:         256
});

const arr = (n) => `var a=1;for(var i=0;i<${n};i++){a=[a];}`;
const obj = (n) => `var o={};for(var i=0;i<${n};i++){o={a:o};}`;
const txt = (n) => `var t='['.repeat(${n})+']'.repeat(${n});`;
const SINK_BODY = Object.freeze({
    recurse:      (n) => `function r(k){ if(k<=0){ return 0; } return 1+r(k-1); } return r(${n});`,
    parse:        (n) => txt(n) + 'return JSON.parse(t).length;',
    parseReviver: (n) => txt(n) + 'return JSON.parse(t,function(k,v){ return v; }).length;',
    stringifyArr: (n) => arr(n) + 'return JSON.stringify(a).length;',
    stringifyObj: (n) => obj(n) + 'return JSON.stringify(o).length;',
    join:         (n) => arr(n) + "return a.join(',').length;",
    string:       (n) => arr(n) + 'return String(a).length;',
    flat:         (n) => arr(n) + 'return a.flat(Infinity).length;'
});

// Contract frames first, then the native walk at the deepest frame.
const framesThen = (frames, tail) =>
    `function r(k){ if(k<=0){ ${tail} } return r(k-1); } return r(${frames});`;
const COMPOSITE = Object.freeze([
    ['rec200+parseReviver@max',  framesThen(200, txt(256) + 'return JSON.parse(t,function(k,v){ return v; }).length;'), 'at'],
    ['rec200+parseReviver@over', framesThen(200, txt(257) + 'return JSON.parse(t,function(k,v){ return v; }).length;'), 'over'],
    ['rec250+parseReviver@max',  framesThen(250, txt(256) + 'return JSON.parse(t,function(k,v){ return v; }).length;'), 'at'],
    ['rec200+join@max',          framesThen(200, arr(256) + "return a.join(',').length;"), 'at'],
    ['rec200+stringifyArr@max',  framesThen(200, arr(256) + 'return JSON.stringify(a).length;'), 'at']
]);

function sinkDepths(max) {
    return [[200, 'below'], [max, 'at'], [max + 1, 'over'], [300, 'deep'], [400, 'deep']];
}

function targetedSpecs() {
    const specs = [];
    for (const sink of Object.keys(SINK_BODY)) {
        for (const [depth, role] of sinkDepths(SINK_MAX[sink])) {
            specs.push({ label: `${sink}@${depth}`, body: SINK_BODY[sink](depth), role });
        }
    }
    for (const [label, body, role] of COMPOSITE) specs.push({ label, body, role });
    return specs;
}

function targetedCases() {
    const cases = [];
    for (const [network, base] of Object.entries(TARGETED_NETWORKS)) {
        targetedSpecs().forEach((s, i) => cases.push({
            index:        base + i,
            label:        `${network}:${s.label}`,
            role:         s.role,
            code:         `module.exports = function(xchain){ ${s.body} };`,
            method:       'default',
            params:       [],
            state:        {},
            network,
            blockContext: POST_GATE_BLOCK
        }));
    }
    return cases;
}

function assertPostGateContext() {
    if (!isPkg3SandboxActive('mainnet', 'BTC', POST_GATE_BLOCK.height)) {
        throw new Error(`post-gate height ${POST_GATE_BLOCK.height} is below the BTC musl-safe height gate`);
    }
    if (!(POST_GATE_BLOCK.timestamp >= BINARY_ALLOC_GATE_BLOCK_TIME)) {
        throw new Error(`post-gate timestamp ${POST_GATE_BLOCK.timestamp} is below the F-NR block-time gate`);
    }
}

// The seeded random corpus re-run past both gates, then the targeted cases.
function buildPostGateCorpus(opts) {
    assertPostGateContext();
    const random = buildCorpus(opts).map(c => Object.assign({}, c, {
        network: 'mainnet', blockContext: POST_GATE_BLOCK
    }));
    return random.concat(targetedCases());
}

// Problems (empty means OK) when a one-past-the-maximum case did not fault.
function checkPostGateRegime(corpus, entries) {
    const byIndex = new Map(entries.map(e => [e.index, e]));
    const problems = [];
    for (const c of corpus) {
        if (c.role !== 'over') continue;
        const e = byIndex.get(c.index);
        if (!e) { problems.push(`${c.label}: no result`); continue; }
        if (!/^out_of_stack/.test(String(e.error || ''))) {
            problems.push(`${c.label}: expected out_of_stack, got ${e.success ? 'success' : JSON.stringify(e.error)}`);
        }
    }
    return problems;
}

async function buildPostGateManifest(opts) {
    const seed = (opts && opts.seed != null) ? opts.seed : DEFAULT_SEED;
    const cases = (opts && opts.cases != null) ? opts.cases : DEFAULT_CASES;
    const execution = (opts && opts.execution) || 'in-process';
    const corpus = buildPostGateCorpus({ seed, cases });
    const entries = await runCorpus(corpus, { execution });
    return {
        version:   1,
        kind:      'vm-differential-fuzz-manifest',
        profile:   'post-gate',
        seed,
        cases,
        targeted:  corpus.length - cases,
        context:   { network: 'mainnet+regtest', blockContext: POST_GATE_BLOCK },
        execution,
        platform:  platformTag(),
        node:      process.versions.node,
        regime:    checkPostGateRegime(corpus, entries),
        entries
    };
}

module.exports = {
    POST_GATE_BLOCK,
    TARGETED_NETWORKS,
    SINK_MAX,
    targetedCases,
    buildPostGateCorpus,
    checkPostGateRegime,
    buildPostGateManifest
};
