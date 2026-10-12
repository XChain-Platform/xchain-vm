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
 ********************************************************************/
'use strict';

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/helpers/harness.js');

const SOURCE = `module.exports = function(){
    var iterations = 0;
    with ({ __gas: Math.abs }) {
        for (var i = 0; i < 10000; i++) { iterations++; }
    }
    return iterations;
};`;

function run(network) {
    const vm = createVM({ gasCeiling: 1000, maxCpuTimeMs: 30000 });
    vm.beginBlock();
    return execute(vm, SOURCE, {
        method: 'default',
        network,
        contractAddress: 'C:BTC:1',
        blockContext: { height: 1, timestamp: 1786060800, hash: 'h' }
    }).then((result) => {
        vm.endBlock();
        return result;
    });
}

(XChainVM ? describe : describe.skip)('with-object gas callback hijack', function () {
    this.timeout(30000);

    it('preserves the historical bypass while the banned-with gate is unarmed', async function () {
        const result = await run('mainnet');
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 10000);
        assert.ok(result.gasUsed < 1000);
    });

    it('rejects the Math.abs-keyed with object when the gate is active', async function () {
        const result = await run('regtest');
        assert.strictEqual(result.success, false);
        assert.match(result.error, /^error: banned syntax: banned statement: with at line 3;/);
    });
});
