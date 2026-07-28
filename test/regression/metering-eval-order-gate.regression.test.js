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
 * Metering eval-order activation gate (L-3 regression)
 *
 * The AST metering transform rewrites a compound string-append on a member
 * target, obj[k] += rhs, into a metered helper call. The legacy rewrite,
 * __setconcat(obj, k, rhs), evaluates rhs as an ordinary argument BEFORE the
 * helper reads obj[k], so a contract whose rhs mutates obj[k] observes the
 * post-mutation value: a divergence from JS spec order, which reads obj[k]
 * (the old value) FIRST and only then evaluates rhs. The spec-correct rewrite,
 * __setconcatL(obj, k, () => rhs), defers rhs behind a thunk so the read comes
 * first.
 *
 * Every node runs the same transform, so the legacy behavior is a shared spec
 * divergence, not a cross-node split; but CORRECTING it changes results (and,
 * for the added thunk indirection, gas) for the affected pattern, so it is
 * gated exactly like the other 2.0.0 contract-era changes: mainnet at the
 * coordinated flag-day (METERING_EVAL_ORDER_GATE_BLOCK_TIME), testnet/regtest
 * from genesis. This fixture pins the flag-day value and both sides of the
 * mainnet gate plus the pre-launch-net genesis activation, so a future edit
 * that drops the gate or shifts the flag day reddens here instead of silently
 * splitting the fleet.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, XChainVM } = require('../fuzz/harness');

// Read the export directly with NO numeric fallback: the old `|| 1786924800`
// silently absorbed a rename/removal of the export (every test still passed
// against the literal). A missing export now yields undefined, which fails the
// flag-day pin test below loudly. XChainVM itself may be absent (no isolated-vm
// build); the describe.skip handles that case.
const GATE = XChainVM ? XChainVM.METERING_EVAL_ORDER_GATE_BLOCK_TIME : undefined;

const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

// rhs mutates o.v to "B" and returns "C". Spec order reads the old "A" first
// (result "AC"); the legacy order evaluates rhs first, so it reads "B" (result
// "BC"). The whole pattern lives in-contract so nothing depends on transport.
const REORDER_CODE = `module.exports = function(){
    var o = { v: "A" };
    o.v += (function(){ o.v = "B"; return "C"; })();
    return o.v;
};`;

// A well-behaved += whose rhs never touches the target: the two sides of the
// gate must agree on the RESULT (only the internal thunk indirection differs).
const CLEAN_CODE = `module.exports = function(){
    var o = { v: "x" };
    o.v += "yz";
    return o.v;
};`;

(XChainVM ? describe : describe.skip)('metering eval-order activation gate (L-3 regression)', function () {
    this.timeout(30000);

    // The shared harness execute() does not thread `network`, so drive vm.execute
    // directly with the same defaults the harness uses.
    const run = (code, blockContext, network) => {
        const vm = createVM();
        vm.beginBlock();
        return vm.execute({ code, state: {}, method: 'default', params: [],
            caller: 'test_addr', contractAddress: 'C:BTC:1', blockContext, network })
            .then(r => { vm.endBlock(); return r; });
    };

    it('the flag day is the pinned coordinated activation timestamp', function () {
        assert.strictEqual(GATE, 1786924800);
    });

    it('mainnet below the flag day: legacy (rhs-first) order is preserved', async function () {
        const res = await run(REORDER_CODE, BEFORE);
        assert.strictEqual(res.success, true, 'pre-flag-day execution must succeed: ' + res.error);
        assert.strictEqual(res.returnValue, '"BC"',
            'below the gate the legacy __setconcat order (read after rhs) must replay');
    });

    it('mainnet at the flag day: spec-correct (read-first) order is used', async function () {
        const res = await run(REORDER_CODE, AT);
        assert.strictEqual(res.success, true, 'at-flag-day execution must succeed: ' + res.error);
        assert.strictEqual(res.returnValue, '"AC"',
            'at/after the gate the spec order (read obj[k] before rhs) must apply');
    });

    it('regtest: spec order active from genesis (pre-flag-day block time still read-first)', async function () {
        const res = await run(REORDER_CODE, BEFORE, 'regtest');
        assert.strictEqual(res.success, true, 'regtest execution must succeed: ' + res.error);
        assert.strictEqual(res.returnValue, '"AC"', 'regtest must use spec order from genesis');
    });

    it('a well-behaved += yields the same result on both sides of the gate', async function () {
        const lo = await run(CLEAN_CODE, BEFORE);
        const hi = await run(CLEAN_CODE, AT);
        assert.strictEqual(lo.success, true, 'below: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at: ' + hi.error);
        assert.strictEqual(lo.returnValue, '"xyz"');
        assert.strictEqual(hi.returnValue, lo.returnValue,
            'a rhs that does not mutate the target must be gate-invariant in result');
    });
});
