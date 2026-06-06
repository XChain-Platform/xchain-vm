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
 * Chaos Experiment 9: Rapid Block Cycling
 *
 * Tests rapid beginBlock()/endBlock() transitions to verify:
 * - Compilation cache is correctly invalidated per block
 * - Block-context-dependent results are not stale from cache
 * - Cache size is bounded by maxBlockCacheSize
 * - No null-dereference or stale-cache bugs
 ********************************************************************/

const assert = require('assert');
const { XChainVM, createVM, execute, chaosAssertions } = require('../helpers/harness');
const { checkResultShape } = require('../../fuzz/invariants');

(XChainVM ? describe : describe.skip)('Chaos: Rapid Block Cycling (Exp 9)', function() {

    it('CHAOS-901: results reflect current block context, not stale cache', async function() {
        this.timeout(30000);
        const vm = createVM();
        const code = `module.exports = function(xchain) {
            return String(xchain.getBlockHeight());
        };`;

        for (let height = 100; height < 120; height++) {
            vm.beginBlock();
            const result = await execute(vm, code, {
                blockContext: { height, timestamp: 1700000000 + height, hash: 'h' + height }
            });
            vm.endBlock();

            checkResultShape(result);
            assert.strictEqual(result.success, true, 'Block ' + height + ' failed: ' + result.error);
            assert.strictEqual(JSON.parse(result.returnValue), String(height),
                'Block ' + height + ' returned stale value: ' + result.returnValue);
        }
    });

    it('CHAOS-902: 100 rapid beginBlock/endBlock without execution', async function() {
        this.timeout(10000);
        const vm = createVM();

        for (let i = 0; i < 100; i++) {
            vm.beginBlock();
            vm.endBlock();
        }

        // VM still works after rapid cycling
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-903: endBlock clears cache completely', async function() {
        this.timeout(15000);
        const vm = createVM();

        vm.beginBlock();
        const code = `module.exports = function(xchain) { return 'cached'; };`;
        await execute(vm, code);

        // Cache should have entries
        assert(vm._blockCache instanceof Map, 'Block cache should be a Map');
        const cacheSize = vm._blockCache.size;

        vm.endBlock();

        // Cache should be null after endBlock
        assert.strictEqual(vm._blockCache, null, 'Block cache should be null after endBlock');
    });

    it('CHAOS-904: cache bounded by maxBlockCacheSize', async function() {
        this.timeout(30000);
        const vm = createVM({ maxBlockCacheSize: 5 });

        vm.beginBlock();

        // Execute 10 unique contracts (each gets a unique hash due to comment)
        for (let i = 0; i < 10; i++) {
            await execute(vm, `/* unique_${i} */ module.exports = function(xchain) { return '${i}'; };`);
        }

        assert(vm._blockCache.size <= 5,
            'Cache size should be bounded at 5, got ' + vm._blockCache.size);

        vm.endBlock();
    });

    it('CHAOS-905: same contract cached within block produces correct results', async function() {
        this.timeout(15000);
        const vm = createVM();
        const code = `module.exports = function(xchain) {
            var id = xchain.getInputParam(0);
            xchain.state.set('caller', id);
            return id;
        };`;

        vm.beginBlock();

        // Execute same contract 5 times with different params
        for (let i = 0; i < 5; i++) {
            const result = await execute(vm, code, { params: [String(i)] });
            checkResultShape(result);
            assert.strictEqual(result.success, true, 'Cached execution ' + i + ' failed: ' + result.error);
            assert.strictEqual(JSON.parse(result.returnValue), String(i),
                'Cached execution ' + i + ' returned wrong value');
        }

        vm.endBlock();
    });

    it('CHAOS-906: execution without beginBlock (no cache) works', async function() {
        this.timeout(10000);
        const vm = createVM();

        // Execute without calling beginBlock — _blockCache is null
        const code = `module.exports = function(xchain) { return 'no_cache'; };`;
        const result = await execute(vm, code);

        checkResultShape(result);
        assert.strictEqual(result.success, true, 'Should work without block cache: ' + result.error);
        assert.strictEqual(JSON.parse(result.returnValue), 'no_cache');
    });

    it('CHAOS-907: rapid block transitions with different contracts', async function() {
        this.timeout(30000);
        const vm = createVM();

        const contracts = [
            `module.exports = function(xchain) { return 'a'; };`,
            `module.exports = function(xchain) { xchain.state.set('k','v'); return 'b'; };`,
            `module.exports = function(xchain) { return xchain.math.add('1','2'); };`,
        ];

        for (let block = 0; block < 50; block++) {
            vm.beginBlock();
            const code = contracts[block % contracts.length];
            const result = await execute(vm, code, {
                blockContext: { height: block, timestamp: 1700000000 + block, hash: 'h' + block }
            });
            checkResultShape(result);
            assert.strictEqual(result.success, true, 'Block ' + block + ' failed: ' + result.error);
            vm.endBlock();
        }

        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-908: double endBlock does not crash', async function() {
        const vm = createVM();

        vm.beginBlock();
        vm.endBlock();
        // Second endBlock — sets null to null, should be harmless
        vm.endBlock();

        assert.strictEqual(vm._blockCache, null);
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-909: beginBlock without endBlock followed by another beginBlock', async function() {
        const vm = createVM();

        vm.beginBlock();
        const code = `module.exports = function(xchain) { return 'first'; };`;
        await execute(vm, code);
        const firstCacheSize = vm._blockCache.size;

        // Start new block without ending the previous one
        vm.beginBlock();
        assert.strictEqual(vm._blockCache.size, 0,
            'New beginBlock should reset cache, got size ' + vm._blockCache.size);

        const result = await execute(vm, `module.exports = function(xchain) { return 'second'; };`);
        assert.strictEqual(result.success, true);

        vm.endBlock();
    });
});
