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
 * Red-team: attestation request_id + math-API determinism.
 *
 * (1) request_id = sha256(txHash : callPath : contractIndex : emissionIndex), where
 *     callPath is the execution's deterministic call-path (root = ''). Probe:
 *     - same inputs -> same id (cross-run determinism; fork-relevant)
 *     - N requests in one execution -> N DISTINCT ids (no intra-tx collision)
 *     - the delimiter cannot be gamed into a collision between
 *       (contractIndex, emissionIndex) pairs
 *     - non-attestation emissions before a request shift its emissionIndex
 *       deterministically (id is a pure function of declared inputs)
 *
 * (2) xchain.math.* is the deterministic bignumber API contracts must use
 *     instead of native transcendentals. Probe a spread of ops + edge cases
 *     for run-to-run determinism and stable string output.
 *
 *   node test/determinism/probe-attestation-and-math-determinism.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute } = require('../fuzz/harness');

const wrap = (b) => `module.exports = function(xchain) { ${b} };`;

async function ret(code, extra) {
    const vm = createVM();
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, code, Object.assign({ method: 'default' }, extra));
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

async function main() {
    let findings = 0;
    process.stdout.write(`Attestation request_id + math determinism probe\n${'='.repeat(74)}\n`);

    // --- (1) request_id determinism + distinctness ---
    const reqCode = wrap(`
        var ids = [];
        ids.push(xchain.attestation.request('http_get','u1','cb',[], {redundancy:1}));
        ids.push(xchain.attestation.request('http_get','u2','cb',[], {redundancy:1}));
        ids.push(xchain.attestation.request('http_get','u3','cb',[], {redundancy:1}));
        return ids.join(',');
    `);
    const ctx = { txHash: 'deadbeef'.repeat(8), contractIndex: 7 };
    const r1 = await ret(reqCode, ctx);
    const r2 = await ret(reqCode, ctx);   // identical inputs -> must match
    const ids1 = (JSON.parse(r1.returnValue || '""') || '').split(',');
    const same = r1.returnValue === r2.returnValue;
    const distinct = new Set(ids1).size === ids1.length && ids1.every(x => /^[0-9a-f]{64}$/.test(x));
    if (!same || !distinct) findings++;
    process.stdout.write(`\n(1a) cross-run determinism : ${same ? 'OK' : 'DIVERGENT ***'}\n`);
    process.stdout.write(`(1b) 3 ids distinct + hex  : ${distinct ? 'OK' : 'COLLISION/MALFORMED ***'}  [${ids1.map(s=>s.slice(0,8)).join(', ')}]\n`);

    // (1c) delimiter cannot be gamed: (idx=1, after 23 emissions) vs (idx=12, after 3)
    // produce different preimages. Build both and confirm the request ids differ.
    const mkAfterN = (n) => wrap(`
        for (var i=0;i<${n};i++) xchain.emit.send({destination:'BTC:a',tick:'T',quantity:'1'});
        return xchain.attestation.request('http_get','u','cb',[], {redundancy:1});
    `);
    const a = await ret(mkAfterN(23), { txHash: 'aa', contractIndex: 1 });
    const b = await ret(mkAfterN(3),  { txHash: 'aa', contractIndex: 12 });
    const noCollide = a.returnValue && b.returnValue && a.returnValue !== b.returnValue;
    if (!noCollide) findings++;
    process.stdout.write(`(1c) delimiter not gameable : ${noCollide ? 'OK' : 'COLLISION ***'}  [${(a.returnValue||'?').slice(1,9)} vs ${(b.returnValue||'?').slice(1,9)}]\n`);

    // (1d) gas charged even when validation fails (anti-DoS): a bad request still costs gas.
    const bad = await ret(wrap(`try { xchain.attestation.request('http_get','u','cb',[], {redundancy:2}); } catch(e){} return 'done';`));
    const charged = bad.success && bad.gasUsed >= 5000;
    if (!charged) findings++;
    process.stdout.write(`(1d) gas charged on reject  : ${charged ? 'OK' : 'NOT CHARGED ***'}  [gasUsed=${bad.gasUsed}]\n`);

    // --- (2) math-API determinism ---
    const mathCode = wrap(`
        var m = xchain.math, o = [];
        o.push(m.add('1.0000000001','2.0000000002'));
        o.push(m.divide('1','3'));
        o.push(m.multiply('123456789012345678','987654321'));
        o.push(m.pow('2','0.5'));
        o.push(m.sqrt('2'));
        o.push(m.log('10'));
        o.push(m.mod('10000000000000001','7'));
        o.push(m.compare('0.1','0.10000000000000001'));
        return o.join('|');
    `);
    const m1 = await ret(mathCode);
    const m2 = await ret(mathCode);
    const mathStable = m1.success && m1.returnValue === m2.returnValue;
    if (!mathStable) findings++;
    process.stdout.write(`\n(2a) math run-to-run stable: ${mathStable ? 'OK' : 'DIVERGENT ***'}\n`);
    process.stdout.write(`     ${(m1.returnValue||m1.error||'').slice(0,150)}\n`);

    // (2b) division by zero must revert deterministically (not NaN/Infinity)
    const dz = await ret(wrap(`try { return xchain.math.divide('1','0'); } catch(e){ return 'revert'; }`));
    const dzOk = dz.success === false || dz.returnValue === '"revert"';
    if (!dzOk) findings++;
    process.stdout.write(`(2b) div-by-zero handled   : ${dzOk ? 'OK' : 'UNDEFINED ***'}  [success=${dz.success} ret=${JSON.stringify(dz.returnValue)} err=${JSON.stringify(dz.error)}]\n`);

    process.stdout.write(`\n${'='.repeat(74)}\n`);
    process.stdout.write(findings
        ? `FINDINGS: ${findings} ***\n`
        : 'No findings — request_id and math are deterministic and collision-free.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
