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
 * NUL-byte state-key rejection activation gate (H-5 regression)
 *
 * A contract state key carrying a raw NUL (0x00) byte breaks the indexer's
 * 0x00-joined merkle leaf encoding (merkle.js joinFields throws on any
 * 0x00-bearing field to keep the join injective), so committing the block
 * merkle root wedges every state-commitment indexer at that block: an
 * F-12-class liveness halt any deployer can trigger. The VM therefore
 * rejects NUL-bearing keys at the state-write boundary, failing the
 * execution deterministically on every node instead.
 *
 * The rejection flips an execution from success to failure, so it is
 * consensus-visible and gated like the other 2.0.0 contract-era changes:
 * mainnet at the coordinated flag-day (STATE_KEY_NUL_GATE_BLOCK_TIME),
 * testnet/regtest from genesis. This fixture pins the flag-day value, both
 * sides of the mainnet gate, and the pre-launch-net genesis activation, so
 * a future edit that drops the gate or shifts the flag day reddens here
 * instead of silently splitting the fleet.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

// Read the export directly with NO numeric fallback: the old `|| 1786060800`
// silently absorbed a rename/removal of the export (every test still passed
// against the literal). A missing export now yields undefined, which fails the
// flag-day pin test below loudly. XChainVM itself may be absent (no isolated-vm
// build); the describe.skip handles that case.
const GATE = XChainVM ? XChainVM.STATE_KEY_NUL_GATE_BLOCK_TIME : undefined;

// One second on either side of the flag day isolates the gate boundary itself.
const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

// The key is built in-contract so the NUL never has to survive any transport
// encoding: 'k' + 0x00 + 'k'.
const NUL_KEY_CODE = `module.exports = function(){
    xchain.state.set('k' + String.fromCharCode(0) + 'k', 'v');
    return 'wrote';
};`;
const CLEAN_KEY_CODE = `module.exports = function(){
    xchain.state.set('k_clean', 'v');
    return 'wrote';
};`;

(XChainVM ? describe : describe.skip)('NUL state-key rejection activation gate (H-5 regression)', function () {
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
        assert.strictEqual(GATE, 1786060800);
    });

    it('mainnet below the flag day: the NUL key write still SUCCEEDS (historical behavior preserved)', async function () {
        const res = await run(NUL_KEY_CODE, BEFORE);
        assert.strictEqual(res.success, true, 'pre-flag-day mainnet must accept the write: ' + res.error);
        assert.ok(res.stateChanges.some(c => c.key.indexOf(String.fromCharCode(0)) !== -1),
            'the NUL-bearing key must appear in stateChanges below the gate');
    });

    it('mainnet at the flag day: the NUL key write FAILS the execution deterministically', async function () {
        const res = await run(NUL_KEY_CODE, AT);
        assert.strictEqual(res.success, false, 'at/after the flag day the write must be rejected');
        assert.ok(/NUL \(0x00\)/.test(res.error || ''), 'error must name the NUL rejection, got: ' + res.error);
        assert.strictEqual((res.stateChanges || []).length, 0, 'no state may escape the failed execution');
    });

    it('regtest: active from genesis (pre-flag-day block time still rejects)', async function () {
        const res = await run(NUL_KEY_CODE, BEFORE, 'regtest');
        assert.strictEqual(res.success, false, 'regtest must reject from genesis');
        assert.ok(/NUL \(0x00\)/.test(res.error || ''), 'error must name the NUL rejection, got: ' + res.error);
    });

    it('clean keys are unaffected on both sides of the gate', async function () {
        const lo = await run(CLEAN_KEY_CODE, BEFORE);
        const hi = await run(CLEAN_KEY_CODE, AT);
        assert.strictEqual(lo.success, true, 'below: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at: ' + hi.error);
    });
});
