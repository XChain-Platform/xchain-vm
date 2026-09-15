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
const fs = require('fs');
const path = require('path');
const { createVM, execute, assertAtomicFailure } = require('./helpers/harness.js');

describe('[P3] Integration Regression', function() {

    // RESOURCE LIMITS
    describe('Resource limits', function() {

        it('should halt infinite loop via gas ceiling', async function() {
            this.timeout(10000);
            const vm = createVM({ gasCeiling: 1000 });
            const r = await execute(vm,
                'module.exports = function(xchain) { while(true) {} };');
            assert.strictEqual(r.success, false);
            assert(r.error.includes('out_of_gas'));
            assertAtomicFailure(r);
        });

        it('should enforce memory limit', async function() {
            this.timeout(10000);
            const vm = createVM({ limits: { maxMemory: 8 } });
            const code = fs.readFileSync(
                path.join(__dirname, '../fixtures/contracts/memory_bomb.js'), 'utf8');
            const r = await execute(vm, code);
            assert.strictEqual(r.success, false);
        });

        it('should enforce emission limit', async function() {
            const vm = createVM();
            const code = fs.readFileSync(
                path.join(__dirname, '../fixtures/contracts/emit_flood.js'), 'utf8');
            const r = await execute(vm, code);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('emission limit'));
        });
    });
});

describe('[P3] Integration Regression', function() {
    // RESOURCE LIMITS
    describe('Resource limits', function() {

        it('should enforce state key limit', async function() {
            const vm = createVM({ limits: { maxStateKeys: 100 } });
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    for (var i = 0; i < 101; i++) xchain.state.set('k' + i, 'v');
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('max state keys'));
        });

        it('should enforce state value size limit', async function() {
            const vm = createVM({ limits: { maxStateValueSize: 100 } });
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    var big = '';
                    for (var i = 0; i < 200; i++) big += 'x';
                    xchain.state.set('k', big);
                };
            `);
            assert.strictEqual(r.success, false);
            assert(r.error.includes('max size'));
        });

        it('should reject code exceeding maxCodeSize', async function() {
            const vm = createVM();
            const r = await execute(vm, '// ' + 'x'.repeat(65540));
            assert.strictEqual(r.success, false);
            assert(r.error.includes('code size exceeds limit'));
        });

        it('should accept code at exactly maxCodeSize', async function() {
            const vm = createVM();
            const header = 'module.exports = function(xchain) { /* ';
            const footer = ' */ };';
            const padding = 65536 - Buffer.byteLength(header + footer, 'utf8');
            const code = header + 'x'.repeat(padding) + footer;
            const r = await execute(vm, code);
            assert.strictEqual(r.success, true);
        });
    });
});
