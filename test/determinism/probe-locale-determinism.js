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
 * Red-team: locale/unicode-sensitive PROTOTYPE methods (determinism).
 *
 * sandbox.js strips the locale-sensitive GLOBALS (Intl, Temporal,
 * performance, structuredClone). But deleting the `Intl` global does NOT
 * disable the locale/ICU-sensitive METHODS that live on the built-in
 * prototypes and work without `Intl`:
 *
 *     String.prototype.normalize     (ICU unicode normalization tables)
 *     String.prototype.localeCompare (ICU collation)
 *     Number.prototype.toLocaleString / Date is gone, but Number/Array remain
 *     Array.prototype.toLocaleString
 *
 * Their output depends on the host's ICU/V8 build. A contract that does
 *     state.set('k', x.normalize('NFKC'))          // or
 *     state.set('k', String((1234.5).toLocaleString()))
 * routes an ICU-version-dependent value into HASHED state. Two validators
 * on different Node 22 patch / ICU builds would then commit different bytes
 * → divergent Merkle root → FORK. This is the same class as Finding F1 (a
 * contract-controlled value reaching hashed state) on a path F1 did not
 * touch.
 *
 * This probe confirms REACHABILITY: it executes each method inside the
 * sandbox and reports whether it is callable and whether its output flows
 * out as a returnValue (the hashed surface). RED = reachable. (Proving
 * cross-ICU DIVERGENCE needs a second ICU build — framed as suspected,
 * exactly like Finding C was before its cross-arch confirmation.)
 *
 *   node test/determinism/probe-locale-determinism.js
 ********************************************************************/
// @ts-nocheck

const { createVM, execute } = require('../fuzz/harness');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

const VECTORS = [
    {
        id: 'String.prototype.normalize (NFKC ligature)',
        risk: 'ICU normalization tables differ across V8/ICU builds',
        // U+FB00 (ﬀ) → "ff" under NFKC. The mapping is ICU-version-dependent.
        code: wrap(`return '\\uFB00'.normalize('NFKC');`)
    },
    {
        id: 'String.prototype.normalize (NFD combining)',
        risk: 'NFC vs NFD byte length is ICU-dependent',
        code: wrap(`return '\\u00C5'.normalize('NFD').length + ':' + '\\u00C5'.normalize('NFC').length;`)
    },
    {
        id: 'String.prototype.localeCompare',
        risk: 'ICU collation order/sign is locale-dependent',
        code: wrap(`return String('a'.localeCompare('B'));`)
    },
    {
        id: 'Number.prototype.toLocaleString',
        risk: 'grouping/decimal separators are locale-dependent',
        code: wrap(`return (1234567.89).toLocaleString();`)
    },
    {
        id: 'Array.prototype.toLocaleString',
        risk: 'delegates to Number/Date toLocaleString (locale-dependent)',
        code: wrap(`return [1234.5, 6789].toLocaleString();`)
    }
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

    // "reachable" = the method ran and produced a value (didn't throw a
    // TypeError for "not a function" / undefined). If the sandbox neutered
    // it, we'd expect success=false with a TypeError, or a benign undefined.
    const reachable = r.success === true && r.returnValue != null;
    return { id: v.id, risk: v.risk, reachable, returnValue: r.returnValue, error: r.error };
}

async function main() {
    process.stdout.write(`Locale/unicode prototype-method reachability probe\n${'='.repeat(78)}\n`);
    const findings = [];
    for (const v of VECTORS) {
        const r = await probe(v);
        const verdict = r.reachable ? 'REACHABLE ***' : 'neutered/blocked';
        if (r.reachable) findings.push(r.id);
        process.stdout.write(`\n${r.id}\n`);
        process.stdout.write(`  risk: ${r.risk}\n`);
        process.stdout.write(`  → ${verdict}\n`);
        process.stdout.write(`  returnValue = ${JSON.stringify(r.returnValue)}` +
            (r.error ? `   error=${JSON.stringify(r.error)}` : '') + '\n');
    }
    process.stdout.write(`\n${'='.repeat(78)}\n`);
    process.stdout.write(findings.length
        ? `FINDINGS (${findings.length} locale/ICU-sensitive methods reachable → suspected fork surface):\n  - ${findings.join('\n  - ')}\n`
        : 'All locale/unicode-sensitive prototype methods are neutered.\n');
}

main().then(() => process.exit(0)).catch(e => {
    process.stderr.write('probe failed: ' + (e && e.stack || e) + '\n');
    process.exit(1);
});
