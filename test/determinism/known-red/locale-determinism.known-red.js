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
 * KNOWN-RED acceptance test — locale/unicode-sensitive prototype methods
 * are reachable inside the sandbox (suspected consensus-fork surface).
 *
 * sandbox.js strips the locale GLOBALS (Intl/Temporal/performance/
 * structuredClone) but NOT the ICU-sensitive METHODS on the built-in
 * prototypes, which work without `Intl`:
 *
 *     String.prototype.normalize       (ICU normalization tables)
 *     String.prototype.localeCompare   (ICU collation)
 *     Number.prototype.toLocaleString  (locale separators)
 *     Array.prototype.toLocaleString   (delegates to the above)
 *
 * Their output depends on the host's ICU/V8 build, so a contract that
 * stores or returns it routes a version-dependent value into HASHED state
 * -> divergent Merkle root across a heterogeneous fleet -> FORK (same class
 * as Finding F1, different path).
 *
 * POST-FIX invariant: these methods must be neutered (removed / throw), so
 * a contract that calls one fails deterministically rather than producing
 * locale-dependent output. RED until sandbox.js neuters them. Excluded from
 * the green suites by the `.known-red.js` suffix. Run explicitly:
 *
 *     npm run test:known-red
 *
 * Evidence: `test/determinism/probe-locale-determinism.js` (all 5 reachable).
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../../fuzz/harness');

const wrap = (body) => `module.exports = function(xchain) { ${body} };`;

async function run(code) {
    const vm = createVM();
    if (typeof vm.beginBlock === 'function') vm.beginBlock();
    const r = await execute(vm, code, { method: 'default' });
    if (typeof vm.endBlock === 'function') vm.endBlock();
    return r;
}

describe('KNOWN-RED: locale/unicode prototype methods must be neutered', function () {
    this.timeout(30000);

    const VECTORS = [
        { id: 'String.prototype.normalize',      code: wrap(`return '\\uFB00'.normalize('NFKC');`) },
        { id: 'String.prototype.localeCompare',  code: wrap(`return String('a'.localeCompare('B'));`) },
        { id: 'Number.prototype.toLocaleString', code: wrap(`return (1234567.89).toLocaleString();`) },
        { id: 'Array.prototype.toLocaleString',  code: wrap(`return [1234.5, 6789].toLocaleString();`) }
    ];

    for (const v of VECTORS) {
        it(`${v.id} must not produce locale/ICU-dependent output`, async function () {
            const r = await run(v.code);
            // Neutered => the method is undefined => calling it throws a TypeError
            // => execute() returns success:false (deterministic failure). Reachable
            // => success:true with an ICU-dependent string in returnValue (today).
            const neutered = r.success === false;
            assert(
                neutered,
                `${v.id} is reachable and returned ${JSON.stringify(r.returnValue)} ` +
                `(success=${r.success}). ICU-version-dependent output can reach hashed ` +
                `state -> consensus fork. It must be neutered in sandbox.js.`
            );
        });
    }
});
