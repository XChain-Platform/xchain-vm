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
 * Compilation cache is LIVE, not dead code (M-15 regression)
 *
 * Under isolated-vm 5.x a Script has no createCachedData() method: cached
 * compilation data is produced via { produceCachedData: true } and read back
 * from script.cachedData (an ExternalCopy), and consumed via { cachedData }.
 * The earlier IsolateManager.getCachedData() called the nonexistent
 * Script.createCachedData(), which threw on every call; both call sites in
 * index.js swallowed that throw, so the per-VM harness cache and the per-block
 * contract cache NEVER populated and every execute re-parsed the ~600-line
 * harness plus the metered contract (a throughput / DoS cost under load).
 *
 * This guard fails if the cache regresses back to dead: it asserts the harness
 * cache and the per-block contract cache actually populate after an execute,
 * and (belt and suspenders on top of cache-determinism.test.js) that a warm
 * execution is byte-identical to the cold one, so the cache stays observably
 * transparent to consensus.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const IsolateManager = require('../../src/isolate.js');
const { createVM, execute, hashResult, XChainVM } = require('../fuzz/harness');

const CODE = `module.exports = function(x){
    var a = [];
    for (var i = 0; i < 25; i++) a.push((i * 7) % 11);
    a.sort();
    return a.indexOf(3) + ':' + a.join(',');
};`;

(XChainVM ? describe : describe.skip)('compilation cache is live (M-15 regression)', function () {
    this.timeout(30000);

    it('IsolateManager produces and consumes V8 cached data under this ivm version', function () {
        const mgr = new IsolateManager({ maxMemory: 8 });
        const { isolate } = mgr.createIsolate();
        const src = 'var x = 1 + 2; x;';
        // Cold compile with no cachedData must PRODUCE a handle (not throw, not null).
        const cold = mgr.compileScript(isolate, src);
        const cached = mgr.getCachedData(cold);
        assert.ok(cached, 'getCachedData must return a produced handle (dead cache regressed)');
        mgr.dispose(isolate);

        // A fresh isolate must ACCEPT that handle (cachedDataRejected === false)
        // and run to the identical result, proving the cache is a real speedup.
        const { isolate: iso2, context: ctx2 } = mgr.createIsolate();
        const warm = mgr.compileScript(iso2, src, cached);
        assert.strictEqual(warm.cachedDataRejected, false,
            'produced cache data must be accepted by a fresh isolate');
        assert.strictEqual(warm.runSync(ctx2), 3);
        mgr.dispose(iso2);
    });

    it('the per-VM harness cache and per-block contract cache populate after execute', async function () {
        const vm = createVM();
        vm.beginBlock();
        assert.strictEqual(vm._harnessCachedData, null, 'harness cache must start empty');
        await execute(vm, CODE, { contractIndex: 7 });
        assert.ok(vm._harnessCachedData, 'harness cache must populate after the first execute (was dead)');
        assert.ok(vm._blockCache && vm._blockCache.size > 0,
            'per-block contract cache must hold at least one entry (was dead)');
        vm.endBlock();
        assert.strictEqual(vm._blockCache, null, 'endBlock clears the per-block cache');
    });

    it('warm-cache execution is byte-identical to cold (cache stays transparent)', async function () {
        const vm = createVM();
        vm.beginBlock();
        const cold = hashResult(await execute(vm, CODE, { contractIndex: 7 }));
        const warm = hashResult(await execute(vm, CODE, { contractIndex: 7 }));
        vm.endBlock();
        assert.strictEqual(warm, cold, 'warm != cold: the live cache changed a consensus-visible result');
    });
});
