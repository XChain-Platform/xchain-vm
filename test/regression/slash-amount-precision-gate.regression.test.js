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
 * contract.slash amount-precision activation gate ( regression)
 *
 * contract.slash validated its `amount` against /^[0-9]+(\.[0-9]{1,8})?$/, an
 * 8-decimal ceiling the rest of the seam does not share: STAKE v3 bounds a stake's
 * precision by the token's own DECIMALS (xchain-indexer src/actions/stake.js) up to
 * MAX_TOKEN_DECIMALS 18 (xchain-indexer src/config.js:122), and slashContractStake
 * (xchain-indexer src/db.js) deliberately does its deduction arithmetic at that same
 * per-token precision. So an exact partial ("graduated") slash of a 9-to-18-decimal
 * staked token could never be emitted: it threw at the gateway before the indexer
 * ever saw it, for exactly the tokens the documented any-token staking API accepts.
 *
 * ACCEPTING a call that previously threw is as consensus-visible as rejecting one
 * that previously succeeded, so the widening rides an activation gate rather than
 * landing bare: mainnet at the coordinated flag-day, testnet/regtest from genesis.
 * It rides the existing BINARY_ALLOC flag-day rather than minting a new gate
 * constant, the same choice its sibling  token-delimiter guard made, so the
 * frozen six-gate consensus pin is untouched.
 *
 * This fixture pins the flag-day value, the 18-digit ceiling, both sides of the
 * mainnet gate, and the pre-launch-net genesis activation, so an edit that drops
 * the gate, shifts the flag day, or diverges the ceiling from the indexer's
 * MAX_TOKEN_DECIMALS reddens here instead of silently splitting the fleet.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

// Read the exports directly with no numeric fallback, so a rename or removal
// yields undefined and fails the pins below loudly instead of being absorbed.
const GATE     = XChainVM ? XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME : undefined;
const isActive = XChainVM ? XChainVM.isSlashAmountPrecisionActive : undefined;
const MAX_DP   = XChainVM ? XChainVM.MAX_SLASH_AMOUNT_DECIMALS : undefined;

// One second on either side of the flag day isolates the gate boundary itself.
const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

const PUBKEY = 'a'.repeat(64);
// 18 fractional digits: the ceiling itself, and the shape a graduated slash of an
// 18-decimal staked token produces.
const AMOUNT_18DP = '100.123456789012345678';
// 9 fractional digits: one past the legacy ceiling, the smallest amount the old
// regex rejected and the widened one accepts.
const AMOUNT_9DP  = '100.123456789';
// 19 fractional digits: one past the token ceiling, rejected on BOTH sides.
const AMOUNT_19DP = '100.1234567890123456789';
// 8 fractional digits: legal under both regexes, the byte-identity control.
const AMOUNT_8DP  = '100.12345678';

const slashCode = (amount) => `module.exports = function(){
    xchain.contract.slash('${PUBKEY}', 'TOK', '${amount}');
    return 'slashed';
};`;

const run = (vm, code, blockContext, network) =>
    execute(vm, code, { method: 'default', blockContext, network, contractIndex: 100 });

(XChainVM ? describe : describe.skip)('contract.slash amount precision activation gate ( regression)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('the flag day is the pinned coordinated activation timestamp', function () {
        assert.strictEqual(GATE, 1786060800);
    });

    it('the post-activation ceiling equals the indexer MAX_TOKEN_DECIMALS', function () {
        // xchain-indexer/src/config.js:122 sets MAX_TOKEN_DECIMALS = 18. A VM ceiling
        // above it would emit an amount the slash arithmetic cannot represent; below
        // it re-opens the gap this gate exists to close.
        assert.strictEqual(MAX_DP, 18);
    });

    it('the resolver is network-aware: pre-launch nets from genesis, mainnet at the flag day', function () {
        assert.strictEqual(typeof isActive, 'function', 'the gate resolver must stay exported');
        assert.strictEqual(isActive('regtest', GATE - 1), true);
        assert.strictEqual(isActive('testnet', GATE - 1), true);
        assert.strictEqual(isActive('mainnet', GATE - 1), false);
        assert.strictEqual(isActive('mainnet', GATE), true);
        // An absent/garbage block time must never activate a consensus change.
        assert.strictEqual(isActive('mainnet', undefined), false);
        assert.strictEqual(isActive(undefined, NaN), false);
    });

    it('mainnet below the flag day: a 9-dp amount still THROWS (historical behavior preserved)', async function () {
        const res = await run(vm, slashCode(AMOUNT_9DP), BEFORE);
        assert.strictEqual(res.success, false, 'pre-flag-day mainnet must keep rejecting >8 dp');
        assert.ok(/amount must be a positive decimal string/.test(res.error || ''),
            'error must name the amount rejection, got: ' + res.error);
        assert.strictEqual((res.emittedActions || []).length, 0,
            'no emission may escape the failed execution');
    });

    it('mainnet below the flag day: an 18-dp amount still THROWS', async function () {
        const res = await run(vm, slashCode(AMOUNT_18DP), BEFORE);
        assert.strictEqual(res.success, false, 'pre-flag-day mainnet must keep rejecting >8 dp');
        assert.strictEqual((res.emittedActions || []).length, 0);
    });

    it('mainnet at the flag day: an 18-dp amount EMITS, byte-identical', async function () {
        const res = await run(vm, slashCode(AMOUNT_18DP), AT);
        assert.strictEqual(res.success, true, 'at/after the flag day the slash must be accepted: ' + res.error);
        assert.strictEqual(res.emittedActions.length, 1);
        assert.strictEqual(res.emittedActions[0].action, 'SLASH');
        assert.strictEqual(res.emittedActions[0].params.amount, AMOUNT_18DP,
            'the amount must reach the emission byte-identical, never re-rounded');
    });

    it('mainnet at the flag day: a 9-dp amount EMITS (the first digit past the legacy ceiling)', async function () {
        const res = await run(vm, slashCode(AMOUNT_9DP), AT);
        assert.strictEqual(res.success, true, 'at: ' + res.error);
        assert.strictEqual(res.emittedActions[0].params.amount, AMOUNT_9DP);
    });

    it('regtest: active from genesis (pre-flag-day block time already accepts 18 dp)', async function () {
        const res = await run(vm, slashCode(AMOUNT_18DP), BEFORE, 'regtest');
        assert.strictEqual(res.success, true, 'regtest must accept from genesis: ' + res.error);
        assert.strictEqual(res.emittedActions[0].params.amount, AMOUNT_18DP);
    });

    it('19 dp is past the token ceiling and is rejected on BOTH sides of the gate', async function () {
        const lo = await run(vm, slashCode(AMOUNT_19DP), BEFORE);
        const hi = await run(vm, slashCode(AMOUNT_19DP), AT);
        assert.strictEqual(lo.success, false, 'below the gate 19 dp must throw');
        assert.strictEqual(hi.success, false, 'above the gate 19 dp must still throw');
        assert.ok(/amount must be a positive decimal string/.test(hi.error || ''), hi.error);
    });

    it('an 8-dp amount is unaffected on both sides of the gate', async function () {
        const lo = await run(vm, slashCode(AMOUNT_8DP), BEFORE);
        const hi = await run(vm, slashCode(AMOUNT_8DP), AT);
        assert.strictEqual(lo.success, true, 'below: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at: ' + hi.error);
        // Byte-identical emissions on both sides: the gate widens or narrows what is
        // ACCEPTED, it never rewrites an accepted amount. (gasUsed is deliberately NOT
        // compared across the flag day: the other changes riding this same timestamp,
        // binary-alloc metering and the F-MO math-output hook, legitimately move it.)
        assert.deepStrictEqual(lo.emittedActions, hi.emittedActions);
        assert.strictEqual(lo.emittedActions[0].params.amount, AMOUNT_8DP);
    });
});
