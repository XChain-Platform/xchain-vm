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
 * Canonical string state-key activation gate regression
 *
 * Legacy StateManager key handling is type-blind: the max-key-size and NUL
 * guards test `typeof key === 'string'` (a non-string key skips both), and
 * `key in state` string-coerces while the dirty Map is identity-keyed, so
 * the numeric key 1 and the string key '1' register as TWO live keys (two
 * keyCount bumps against maxStateKeys) that collapse to ONE row when the
 * indexer string-coerces the emitted key.
 *
 * Post-gate (STATE_KEY_TYPE_GATE_BLOCK_TIME) every key funnels through one
 * normalization choke point: string/number/boolean coerce via String(key)
 * so every guard applies to the canonical form and 1 === '1' everywhere;
 * object/array/null/undefined keys throw deterministically. The change is
 * consensus-visible (which writes are valid + how keys are counted), so it
 * is gated like the other 2.0.0 contract-era changes: mainnet at the
 * coordinated flag-day, testnet/regtest from genesis. This fixture pins
 * both sides of the mainnet gate and the genesis activation.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

// No numeric fallback: a renamed/removed export yields undefined and fails
// the pin test loudly (the describe.skip handles a missing isolated-vm).
const GATE = XChainVM ? XChainVM.STATE_KEY_TYPE_GATE_BLOCK_TIME : undefined;

const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

// Writes under the NUMERIC key 1, then the STRING key '1'. Legacy: two dirty
// entries, two keyCount bumps, a numeric key escapes in stateChanges.
// Post-gate: one canonical '1' row, last write wins.
const DUP_KEY_CODE = `module.exports = function(){
    xchain.state.set(1, 'num');
    xchain.state.set('1', 'str');
    return xchain.state.get(1);
};`;
// A non-primitive key: post-gate this must fail the execution
// deterministically at the state boundary.
const OBJECT_KEY_CODE = `module.exports = function(){
    xchain.state.set({ a: 1 }, 'v');
    return 'wrote';
};`;
const CLEAN_KEY_CODE = `module.exports = function(){
    xchain.state.set('k_clean', 'v');
    return 'wrote';
};`;

(XChainVM ? describe : describe.skip)('canonical string state-key activation gate regression', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    // The shared harness execute() does not thread `network`, so the
    // network-aware case calls vm.execute directly with the same defaults.
    const run = (code, blockContext, network) => network
        ? vm.execute({ code, state: {}, method: 'default', params: [],
            caller: 'test_addr', contractAddress: 'C:BTC:1', blockContext, network })
        : execute(vm, code, { method: 'default', blockContext });

    it('the flag day is the pinned coordinated activation timestamp', function () {
        assert.strictEqual(GATE, 1790812800);
    });

    it('mainnet below the flag day: legacy type-blind behavior replays (1 and \'1\' are two keys)', async function () {
        const res = await run(DUP_KEY_CODE, BEFORE);
        assert.strictEqual(res.success, true, 'pre-flag-day mainnet must accept the writes: ' + res.error);
        // Legacy: identity-keyed dirty map keeps the numeric 1 and string '1'
        // as separate entries, and the numeric key escapes unchanged.
        assert.strictEqual(res.stateChanges.length, 2,
            'legacy must emit two dirty rows, got ' + JSON.stringify(res.stateChanges));
        assert.ok(res.stateChanges.some(c => typeof c.key === 'number'),
            'legacy must emit the raw numeric key below the gate');
    });

    it('mainnet at the flag day: 1 and \'1\' collapse to one canonical string key', async function () {
        const res = await run(DUP_KEY_CODE, AT);
        assert.strictEqual(res.success, true, 'at the flag day the writes must succeed: ' + res.error);
        assert.strictEqual(res.stateChanges.length, 1,
            'post-gate the two writes must collapse to one row, got ' + JSON.stringify(res.stateChanges));
        assert.strictEqual(res.stateChanges[0].key, '1', 'the emitted key must be the canonical string');
        assert.strictEqual(res.stateChanges[0].value, 'str', 'last write wins on the canonical key');
        assert.strictEqual(JSON.parse(res.returnValue), 'str', 'get(1) must read the canonical \'1\' row');
    });

    it('mainnet below the flag day: an object key still writes (legacy, type-blind)', async function () {
        const res = await run(OBJECT_KEY_CODE, BEFORE);
        assert.strictEqual(res.success, true, 'legacy must accept the non-primitive key: ' + res.error);
    });

    it('mainnet at the flag day: an object key fails the execution deterministically', async function () {
        const res = await run(OBJECT_KEY_CODE, AT);
        assert.strictEqual(res.success, false, 'post-gate a non-primitive key must be rejected');
        assert.ok(/state key must be a string, number, or boolean/.test(res.error || ''),
            'error must name the key-type rejection, got: ' + res.error);
        assert.strictEqual((res.stateChanges || []).length, 0, 'no state may escape the failed execution');
    });

    it('regtest: active from genesis (pre-flag-day block time still normalizes)', async function () {
        const res = await run(DUP_KEY_CODE, BEFORE, 'regtest');
        assert.strictEqual(res.success, true, 'regtest run failed: ' + res.error);
        assert.strictEqual(res.stateChanges.length, 1, 'regtest must normalize from genesis');
        assert.strictEqual(res.stateChanges[0].key, '1');
    });

    it('clean string keys are unaffected on both sides of the gate', async function () {
        const lo = await run(CLEAN_KEY_CODE, BEFORE);
        const hi = await run(CLEAN_KEY_CODE, AT);
        assert.strictEqual(lo.success, true, 'below: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at: ' + hi.error);
    });
});
