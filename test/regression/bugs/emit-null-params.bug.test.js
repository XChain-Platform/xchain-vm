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
 * [BUG] Several emit methods crashed on null parameters
 *
 * The emit gateway read fields off the params object before checking
 * that one was passed, so `xchain.emit.send(null)` threw a host-side
 * TypeError out of the isolate boundary instead of producing a normal
 * failed execution. A contract-triggerable host fault is a validator
 * availability bug, and different hosts can disagree about it, so it
 * is also a consensus risk.
 *
 * Witness: every emit method, called with null and with undefined,
 * yields a well-formed result, and a rejection is atomic. The VM stays
 * usable for the next execution.
 *
 * Run: npm run test:regression:bugfix
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, assertResultShape } = require('../helpers.js');

describe('[BUG] emit methods survive null parameters', function() {

    let vm;
    let emitMethods;

    before(async function() {
        this.timeout(30000);
        vm = createVM();
        // Read the namespace from the isolate rather than hardcoding it,
        // so a newly added emit method is covered the day it lands.
        const r = await execute(vm,
            'module.exports = function(xchain) { return Object.keys(xchain.emit); };');
        assert.strictEqual(r.success, true, r.error);
        emitMethods = JSON.parse(r.returnValue);
        assert(emitMethods.length > 0, 'xchain.emit must expose methods');
    });

    for (const arg of ['null', 'undefined']) {
        it(`handles every emit method called with ${arg}`, async function() {
            this.timeout(60000);
            for (const method of emitMethods) {
                const r = await execute(vm,
                    `module.exports = function(xchain) { xchain.emit.${method}(${arg}); return 'returned'; };`);

                assertResultShape(r);
                if (r.success) continue;   // a method with defaults may legitimately accept it

                assert.strictEqual(typeof r.error, 'string',
                    `emit.${method}(${arg}) must fail with an error string, not a host fault`);
                assert(!/cannot read propert/i.test(r.error),
                    `emit.${method}(${arg}) leaked a host TypeError: ${r.error}`);
                assert.strictEqual(r.stateChanges.length, 0,
                    `emit.${method}(${arg}) must fail atomically`);
                assert.strictEqual(r.emittedActions.length, 0,
                    `emit.${method}(${arg}) must emit nothing when it rejects`);
            }
        });
    }

    it('leaves the VM usable after a rejected emit', async function() {
        this.timeout(30000);
        await execute(vm,
            "module.exports = function(xchain) { xchain.emit.send(null); return 1; };");
        const r = await execute(vm,
            "module.exports = function(xchain) { return 'still-alive'; };");
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'still-alive');
    });
});
