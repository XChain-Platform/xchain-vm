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
 * [P3] Boundary & Integration Regression Tests
 *
 * Resource limits at configured boundaries, full execution pipeline,
 * compilation cache, E2E critical paths.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute } = require('../helpers/harness.js');

describe('[P3] Integration Regression', function() {
    // COMPILATION CACHE
    describe('Compilation cache', function() {

        it('should produce same results with and without cache', async function() {
            const vm = createVM();
            const code = `module.exports = function(xchain) {
                xchain.state.set('x', xchain.math.add('1', '2'));
                return xchain.state.get('x');
            };`;
            const opts = { contractIndex: 1 };

            // Cold run
            const r1 = await execute(vm, code, opts);
            // Warm run with beginBlock/endBlock cycle
            vm.beginBlock();
            const r2 = await execute(vm, code, opts);
            vm.endBlock();

            assert.strictEqual(r1.success, r2.success);
            assert.strictEqual(r1.returnValue, r2.returnValue);
            assert.strictEqual(r1.gasUsed, r2.gasUsed);
        });
    });
});
