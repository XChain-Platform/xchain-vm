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
 * contract.slash token wire-delimiter activation gate (regression)
 *
 * Every emit validator that hands the indexer a field it may pipe-join rejects
 * an embedded '|' (emit.execute method/params, emit.crossExecute callbackMethod,
 * attestation.request feeTick/feeAmount). contract.slash's `token` was the one
 * hole: it only checked non-empty-string, so a '|'-bearing token flowed into the
 * SLASH emission unexamined.
 *
 * It is inert against today's consumer, and this fixture's sibling in the indexer
 * (test/unit/actions/execute.test.js, "consumes a delimiter-bearing token whole")
 * pins why: _processSlashEmission reads {contractIndex, pubkey, token, amount} by
 * NAMED field and never pipe-splits, and SLASH never reaches the wire. The guard
 * is defense-in-depth for the day SLASH is joined field-by-field like EXECUTE's
 * METHOD_PARAMS, where an embedded '|' would shift the receiver's arity.
 *
 * Rejecting a call that used to emit successfully is consensus-visible, so the
 * guard is gated like the other 2.0.0 contract-era changes: mainnet at the
 * coordinated flag-day, testnet/regtest from genesis. It rides the existing
 * BINARY_ALLOC flag-day rather than minting a seventh gate constant (the same
 * choice the F-MO math-output and F-PS proto-strip gateway gates made), so the
 * frozen six-gate consensus pin is untouched. This fixture pins the flag-day
 * value, both sides of the mainnet gate, and the pre-launch-net genesis
 * activation, so an edit that drops the gate or shifts the flag day reddens here
 * instead of silently splitting the fleet.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

// Read the exports directly with no numeric fallback, so a rename or removal
// yields undefined and fails the pin below loudly instead of being absorbed.
const GATE = XChainVM ? XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME : undefined;
const isActive = XChainVM ? XChainVM.isSlashTokenDelimGuardActive : undefined;

// One second on either side of the flag day isolates the gate boundary itself.
const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

const PUBKEY = 'a'.repeat(64);
// The '|' is assembled in-contract so the delimiter never has to survive any
// transport encoding on the way into the isolate.
const DIRTY_CODE = `module.exports = function(){
    xchain.contract.slash('${PUBKEY}', 'TO' + String.fromCharCode(124) + 'K', '100.00000000');
    return 'slashed';
};`;
const CLEAN_CODE = `module.exports = function(){
    xchain.contract.slash('${PUBKEY}', 'TOK', '100.00000000');
    return 'slashed';
};`;

const run = (vm, code, blockContext, network) =>
    execute(vm, code, { method: 'default', blockContext, network, contractIndex: 100 });

(XChainVM ? describe : describe.skip)('contract.slash token delimiter activation gate (regression)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('the flag day is the pinned coordinated activation timestamp', function () {
        assert.strictEqual(GATE, 1786060800);
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

    it('mainnet below the flag day: the delimiter-bearing token still EMITS (historical behavior preserved)', async function () {
        const res = await run(vm, DIRTY_CODE, BEFORE);
        assert.strictEqual(res.success, true, 'pre-flag-day mainnet must accept the slash: ' + res.error);
        assert.strictEqual(res.emittedActions.length, 1);
        assert.strictEqual(res.emittedActions[0].action, 'SLASH');
        assert.strictEqual(res.emittedActions[0].params.token, 'TO|K',
            'below the gate the token must reach the emission byte-identical');
    });

    it('mainnet at the flag day: the delimiter-bearing token FAILS the execution deterministically', async function () {
        const res = await run(vm, DIRTY_CODE, AT);
        assert.strictEqual(res.success, false, 'at/after the flag day the slash must be rejected');
        assert.ok(/must not contain/.test(res.error || ''),
            'error must name the delimiter rejection, got: ' + res.error);
        assert.strictEqual((res.emittedActions || []).length, 0,
            'no emission may escape the failed execution');
    });

    it('regtest: active from genesis (pre-flag-day block time still rejects)', async function () {
        const res = await run(vm, DIRTY_CODE, BEFORE, 'regtest');
        assert.strictEqual(res.success, false, 'regtest must reject from genesis');
        assert.ok(/must not contain/.test(res.error || ''),
            'error must name the delimiter rejection, got: ' + res.error);
    });

    it('a delimiter-free token is unaffected on both sides of the gate', async function () {
        const lo = await run(vm, CLEAN_CODE, BEFORE);
        const hi = await run(vm, CLEAN_CODE, AT);
        assert.strictEqual(lo.success, true, 'below: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at: ' + hi.error);
        // Byte-identical emissions on both sides: the guard rejects or passes, it
        // never rewrites the token. (gasUsed is deliberately NOT compared across
        // the flag day: the other changes riding this same timestamp, binary-alloc
        // metering and the F-MO math-output hook, legitimately move it.)
        assert.deepStrictEqual(lo.emittedActions, hi.emittedActions);
        assert.strictEqual(lo.emittedActions[0].params.token, 'TOK');
    });
});
