/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Red-team: per-block compilation-cache determinism.
 *
 * The VM caches V8 cachedData per block, keyed by `contractIndex:sha256(code)`.
 * The FIRST execute of a contract in a block compiles cold and stores
 * cachedData; subsequent executes of the same contract in the same block
 * compile WARM (cachedData passed to compileScriptSync). If a warm-cache
 * execution ever diverges from a cold one — different gasUsed, returnValue,
 * stateChanges, emissions — validators that hit the cache at different times
 * would commit different bytes -> fork.
 *
 * This probe asserts byte-identical result hashes for:
 *   (A) cold (1st in block) vs warm (2nd+ in block) — same VM instance
 *   (B) warm vs a fresh-VM cold run (cross-block / cross-validator analogue)
 *   (C) same code at a DIFFERENT contractIndex (distinct cache key — no
 *       cross-contract cachedData bleed)
 *
 *   node test/determinism/probe-compilation-cache-determinism.js
 ********************************************************************/
// @ts-nocheck

const crypto = require('crypto');
const { createVM, execute, hashResult } = require('../fuzz/harness');

// Contracts exercising compute, state, emission, and a deep/branchy body so the
// compiled bytecode (and thus cachedData) is non-trivial.
const CONTRACTS = {
    compute: `module.exports = function(x){ var a=[]; for(var i=0;i<40;i++)a.push((i*7)%13); a.sort(); return a.indexOf(5)+':'+a.join(','); }`,
    stateful: `module.exports = function(x){ var n=Number(x.state.get('c')||'0'); x.state.set('c', String(n+1)); x.emit.send({destination:'BTC:a',tick:'T',quantity:'1'}); return 'n='+n; }`,
    branchy: `module.exports = function(x){ var s=0; for(var i=0;i<30;i++){ if(i%2){ s+=i; } else if(i%3){ s-=1; } else { s*=2; } } try { return String(s); } catch(e){ return 'e'; } }`
};

const PARAMS = { method: 'default', state: { c: '5' }, contractIndex: 7 };

function runIn(vm, code, extra) {
    return execute(vm, code, Object.assign({}, PARAMS, extra));
}

async function main() {
    process.stdout.write(`Compilation-cache determinism probe\n${'='.repeat(72)}\n`);
    let findings = 0;

    for (const [name, code] of Object.entries(CONTRACTS)) {
        // (A) cold then warm in the SAME block (same VM)
        const vm = createVM();
        vm.beginBlock();
        const cold = hashResult(await runIn(vm, code));
        const warm1 = hashResult(await runIn(vm, code));
        const warm2 = hashResult(await runIn(vm, code));
        vm.endBlock();

        // (B) fresh VM, cold (cross-validator / cross-block analogue)
        const vm2 = createVM();
        vm2.beginBlock();
        const freshCold = hashResult(await runIn(vm2, code));
        vm2.endBlock();

        // (C) same code, DIFFERENT contractIndex (distinct cache key)
        const vm3 = createVM();
        vm3.beginBlock();
        const idxA = hashResult(await runIn(vm3, code, { contractIndex: 1 }));
        const idxB = hashResult(await runIn(vm3, code, { contractIndex: 2 }));
        vm3.endBlock();

        const aOk = (cold === warm1 && warm1 === warm2);
        const bOk = (warm2 === freshCold);
        const cOk = (idxA === idxB); // same code+state at different index must still match
        if (!aOk || !bOk || !cOk) findings++;

        process.stdout.write(`\n${name}\n`);
        process.stdout.write(`  (A) cold==warm1==warm2 : ${aOk ? 'OK' : 'DIVERGENT ***'}  [${cold.slice(0,12)} / ${warm1.slice(0,12)} / ${warm2.slice(0,12)}]\n`);
        process.stdout.write(`  (B) warm==freshCold    : ${bOk ? 'OK' : 'DIVERGENT ***'}  [${freshCold.slice(0,12)}]\n`);
        process.stdout.write(`  (C) idx1==idx2 (no bleed): ${cOk ? 'OK' : 'DIVERGENT ***'}  [${idxA.slice(0,12)} / ${idxB.slice(0,12)}]\n`);
    }

    process.stdout.write(`\n${'='.repeat(72)}\n`);
    process.stdout.write(findings
        ? `FINDINGS: ${findings} contract(s) show cache-dependent divergence ***\n`
        : 'No cache-dependent divergence — cold and warm executions are byte-identical.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
