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
 * Harness selection: every combination of the harness activations derives a
 * harness that keeps each unarmed line at its number, the empty combination is
 * HARNESS_SOURCE itself, and mainnet and testnet select it today.
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const select = require('../../../src/index/armed_harness/select.js');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');

describe('armed harness selection: per execution', function () {
    it('assigns the toString size meter its own selectable bit', function () {
        const rule = select.RULES.find(({ LABEL }) => LABEL === 'tostring size meter');
        assert.ok(rule);
        const bit = 1 << select.RULES.indexOf(rule);
        assert.strictEqual(select.harnessMask({ toStringSizeMeter: true }), bit);
    });

    it('selects the unarmed harness on mainnet and testnet and every rule on regtest', function () {
        const far = { blockContext: { height: 1e9, timestamp: 4102444800 } };
        assert.strictEqual(select.executionHarnessMask(Object.assign({ network: 'mainnet' }, far), 'BTC', 1e9, false, false), 0, 'mainnet');
        // Testnet below its v0.24.0 arms (BTC 156908, change instant 1792303200) still selects the unarmed harness.
        const preArm = { network: 'testnet', blockContext: { height: 156907, timestamp: 1792303199 } };
        assert.strictEqual(select.executionHarnessMask(preArm, 'BTC', 156907, false, false), 0, 'testnet');
        const all = (1 << select.RULES.length) - 1;
        assert.strictEqual(select.executionHarnessMask(Object.assign({ network: 'regtest' }, far), 'BTC', 1e9, true, true), all);
    });

    (XChainVM ? it : it.skip)('an unarmed execution compiles HARNESS_SOURCE and leaves the armed cache empty', async function () {
        this.timeout(60000);
        const vm = createVM();
        vm.beginBlock();
        try {
            const code = 'module.exports = function(xchain) { return 1; };';
            const ctx = { height: 961000, timestamp: 1790000000, hash: 'h' };
            const r = await execute(vm, code, { network: 'mainnet', contractAddress: 'C:BTC:1', blockContext: ctx });
            assert.strictEqual(r.success, true, r.error);
            assert.ok(vm._harnessCachedData);
            assert.ok(!vm._armedHarnessCache || vm._armedHarnessCache.size === 0);
            await execute(vm, code, { network: 'regtest', contractAddress: 'C:BTC:1', blockContext: ctx });
            assert.strictEqual(vm._armedHarnessCache.size, 1);
        } finally {
            vm.endBlock();
        }
    });
});
