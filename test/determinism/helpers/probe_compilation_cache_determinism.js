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
 * Red-team: per-block compilation-cache determinism.
 *
 * The VM caches V8 cachedData per block, keyed by `contractIndex:sha256(code)`.
 * The FIRST execute of a contract in a block compiles cold and stores
 * cachedData; subsequent executes of the same contract in the same block
 * compile WARM (cachedData passed to compileScriptSync). If a warm-cache
 * execution ever diverges from a cold one (different gasUsed, returnValue,
 * stateChanges, emissions), validators that hit the cache at different times
 * would commit different bytes -> fork.
 *
 * This probe asserts byte-identical result hashes for:
 *   (A) cold (1st in block) vs warm (2nd+ in block), same VM instance
 *   (B) warm vs a fresh-VM cold run (cross-block / cross-validator analogue)
 *   (C) same code at a DIFFERENT contractIndex (distinct cache key, no
 *       cross-contract cachedData bleed)
 *
 *   node test/determinism/helpers/probe_compilation_cache_determinism.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute, hashResult } = require('../../fuzz/helpers/harness.js');

// Contracts exercising compute, state, emission, and a deep/branchy body so the
// compiled bytecode (and thus cachedData) is non-trivial.
const CONTRACTS = {
    compute: {
        code: `module.exports = function(x){ var a=[]; for(var i=0;i<40;i++)a.push((i*7)%13); a.sort(); return a.indexOf(5)+':'+a.join(','); }`,
        expected: JSON.stringify('25:0,0,0,0,1,1,1,10,10,10,11,11,11,12,12,12,2,2,2,3,3,3,4,4,4,5,5,5,6,6,6,7,7,7,8,8,8,9,9,9')
    },
    stateful: {
        code: `module.exports = function(x){ var n=Number(x.state.get('c')||'0'); x.state.set('c', String(n+1)); x.emit.send({destination:'BTC:a',tick:'T',quantity:'1'}); return 'n='+n; }`,
        expected: JSON.stringify('n=5')
    },
    branchy: {
        code: `module.exports = function(x){ var s=0; for(var i=0;i<30;i++){ if(i%2){ s+=i; } else if(i%3){ s-=1; } else { s*=2; } } try { return String(s); } catch(e){ return 'e'; } }`,
        expected: JSON.stringify('685')
    }
};

const PARAMS = { method: 'default', state: { c: '5' }, contractIndex: 7 };

function runIn(vm, code, extra) {
    return execute(vm, code, Object.assign({}, PARAMS, extra));
}

async function collectRuns(code) {
    const vm = createVM();
    vm.beginBlock();
    const cold = await runIn(vm, code);
    const warm1 = await runIn(vm, code);
    const warm2 = await runIn(vm, code);
    vm.endBlock();
    const vm2 = createVM();
    vm2.beginBlock();
    const freshCold = await runIn(vm2, code);
    vm2.endBlock();
    const vm3 = createVM();
    vm3.beginBlock();
    const idxA = await runIn(vm3, code, { contractIndex: 1 });
    const idxB = await runIn(vm3, code, { contractIndex: 2 });
    vm3.endBlock();
    return { cold, warm1, warm2, freshCold, idxA, idxB };
}

async function probeContract(name, spec) {
    const results = await collectRuns(spec.code);
    const bad = Object.entries(results).filter(([, result]) =>
        result.success !== true || result.returnValue !== spec.expected);
    const hashes = Object.fromEntries(Object.entries(results).map(([key, result]) => [key, hashResult(result)]));
    const aOk = hashes.cold === hashes.warm1 && hashes.warm1 === hashes.warm2;
    const bOk = hashes.warm2 === hashes.freshCold;
    const cOk = hashes.idxA === hashes.idxB;
    process.stdout.write(`\n${name}\n`);
    for (const [runName, result] of bad) {
        process.stdout.write(`  ${runName}: NOT EXECUTED OR WRONG RESULT *** success=${result.success}`
            + ` returnValue=${JSON.stringify(result.returnValue)} error=${result.error}\n`);
    }
    process.stdout.write(`  (A) cold==warm1==warm2 : ${aOk ? 'OK' : 'DIVERGENT ***'}  [${hashes.cold.slice(0,12)} / ${hashes.warm1.slice(0,12)} / ${hashes.warm2.slice(0,12)}]\n`);
    process.stdout.write(`  (B) warm==freshCold    : ${bOk ? 'OK' : 'DIVERGENT ***'}  [${hashes.freshCold.slice(0,12)}]\n`);
    process.stdout.write(`  (C) idx1==idx2 (no bleed): ${cOk ? 'OK' : 'DIVERGENT ***'}  [${hashes.idxA.slice(0,12)} / ${hashes.idxB.slice(0,12)}]\n`);
    return bad.length > 0 || !aOk || !bOk || !cOk;
}

async function main() {
    process.stdout.write(`Compilation-cache determinism probe\n${'='.repeat(72)}\n`);
    let findings = 0;
    for (const [name, spec] of Object.entries(CONTRACTS)) findings += await probeContract(name, spec) ? 1 : 0;

    process.stdout.write(`\n${'='.repeat(72)}\n`);
    process.stdout.write(findings
        ? `FINDINGS: ${findings} contract(s) show cache-dependent divergence ***\n`
        : 'No cache-dependent divergence; cold and warm executions are byte-identical.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
