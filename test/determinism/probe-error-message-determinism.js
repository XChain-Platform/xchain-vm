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
 * Red-team: contract-visible V8 error strings as a consensus input.
 *
 * Finding F1 normalized the HOST-RETURNED status token (timeout/out_of_*
 * collapse to `out_of_resource`) because it is hashed into contract_hash.
 * But a contract can catch its OWN errors and read the raw V8 message /
 * constructor name / stack, then RETURN or STORE it:
 *
 *     try { null.x } catch (e) { xchain.state.set('k', e.message); }
 *     try { f() }    catch (e) { return e.constructor.name; }
 *
 * Those returnValue / stateChange bytes are hashed into the block's Merkle
 * root. V8's native error TEXT is not spec-mandated and has changed across
 * versions (e.g. "Cannot read property 'x' of undefined" ->
 * "Cannot read properties of undefined (reading 'x')" at V8 8.4; stack
 * format and depth-dependent wording also vary). Two validators on
 * different Node/V8 builds would commit different bytes -> divergent root
 * -> FORK. Same class as F1 / the locale finding, on a contract-controlled
 * internal path neither touched.
 *
 * This probe captures EXACTLY what a contract can observe today, so the
 * exposure is concrete. It cannot prove cross-version divergence on one
 * box (only one V8 here); it documents the surface. Mitigation is a
 * deployment/consensus decision (pin exact V8 + cross-version manifest
 * check) and/or sanitizing contract-visible messages where interceptable.
 *
 *   node test/determinism/probe-error-message-determinism.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute } = require('../fuzz/harness');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

// Each vector triggers a NATIVE throw (created by V8 internals, not the JS
// Error constructor, so it can't be intercepted by overriding Error) and
// returns what the contract can observe.
const VECTORS = [
    { id: 'TypeError: call undefined',
      code: wrap(`try { var f; f(); } catch (e) { return e.constructor.name + ' | ' + e.message; }`) },
    { id: 'TypeError: property of undefined',
      code: wrap(`try { var o; return o.x.y; } catch (e) { return e.message; }`) },
    { id: 'TypeError: property of null',
      code: wrap(`try { return null.x; } catch (e) { return e.message; }`) },
    { id: 'TypeError: assign to const',
      code: wrap(`try { const c = 1; (function(){ c = 2; })(); } catch (e) { return e.message; }`) },
    { id: 'RangeError: invalid array length',
      code: wrap(`try { var a = new Array(-1); } catch (e) { return e.constructor.name + ' | ' + e.message; }`) },
    { id: 'RangeError: stack overflow message',
      code: wrap(`function g(){ return 1 + g(); } try { g(); } catch (e) { return e.message; }`) },
    { id: 'SyntaxError via JSON.parse',
      code: wrap(`try { JSON.parse('{bad'); } catch (e) { return e.message; }`) },
    { id: 'error .stack (first 2 lines)',
      code: wrap(`try { null.x; } catch (e) { return String(e.stack).split('\\n').slice(0,2).join(' / '); }`) },
    { id: 'error .toString()',
      code: wrap(`try { var f; f(); } catch (e) { return e.toString(); }`) }
];

async function probe(v) {
    const vm = createVM();
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    let r;
    try {
        r = await execute(vm, v.code, { method: 'default' });
    } catch (e) {
        r = { success: false, error: 'HARNESS_THROW: ' + e.message };
    }
    if (typeof vm.endBlock === 'function') vm.endBlock();
    // Exposed = the contract observed a non-empty native string and routed it
    // out as the (hashed) returnValue.
    const exposed = r.success === true && typeof r.returnValue === 'string' && r.returnValue.length > 2;
    return { id: v.id, exposed, returnValue: r.returnValue, error: r.error };
}

async function main() {
    process.stdout.write(`Contract-visible error-string exposure probe\n${'='.repeat(78)}\n`);
    process.stdout.write(`Each value below is contract-controlled and lands in HASHED state.\n`);
    const findings = [];
    for (const v of VECTORS) {
        const r = await probe(v);
        if (r.exposed) findings.push(r.id);
        process.stdout.write(`\n${r.id}\n  → ${r.exposed ? 'EXPOSED ***' : 'not exposed'}\n`);
        process.stdout.write(`  returnValue = ${JSON.stringify(r.returnValue)}` +
            (r.error ? `  error=${JSON.stringify(r.error)}` : '') + '\n');
    }
    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(findings.length
        ? `FINDINGS (${findings.length} native error strings reach hashed state):\n  - ${findings.join('\n  - ')}\n`
        : 'No contract-visible native error string reaches hashed state.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
