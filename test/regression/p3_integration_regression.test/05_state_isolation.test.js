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
    // STATE ISOLATION
    describe('State isolation', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should not leak state between executions', async function() {
            const r1 = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.state.set('secret', 'confidential');
                    return 'set';
                };
            `, { contractAddress: 'C:BTC:1' });
            assert.strictEqual(r1.success, true);

            // Second execution with different contract sees no state
            const r2 = await execute(vm, `
                module.exports = function(xchain) {
                    return xchain.state.get('secret');
                };
            `, { contractAddress: 'C:BTC:2' });
            assert.strictEqual(r2.success, true);
            assert.strictEqual(JSON.parse(r2.returnValue), null);
        });
    });
});
