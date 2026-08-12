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
 * Set/Map collection-constructor metering: per-coin Pkg 3 height gate
 * (07669055)
 *
 * new Set(bigArr) / new Map(bigEntries) builds an O(n) native hash table for the
 * flat __gas(1) of the call site (the source array is charged once at build and
 * reusable), re-opening the cheap-gas / expensive-CPU grind the F3/G1 wrappers
 * close for the other bulk builtins. __meterCollectionCtor charges the source
 * length/size, gated on the per-coin ~961000 height flag-day (__PKG3_SANDBOX_ON).
 *
 * This suite pins BOTH sides:
 *   - below each coin's height: constructors are UNMETERED (gasUsed byte-identical
 *     to today; a construction loop that would out_of_gas when metered succeeds);
 *   - at/after it: the source size is charged (gasUsed strictly higher; the loop
 *     trips a deterministic out_of_gas);
 *   - per-coin: LTC/DOGE stay unmetered at a bare BTC 961000, meter at their own
 *     calendar heights.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM, GAS_SCHEDULE } = require('../fuzz/harness');
// The execute-time source lint is metered as gas, on this divisor.
const { EXEC_LINT_GAS_BYTES_PER_UNIT } = require('../../src/index.js');

const TS = 1700000000; // the collection-ctor gate keys on height, not block time.

// One Set built from a 500-element array: above the gate this charges +500 gas.
const oneSet = `module.exports = function(xchain){ var a=[]; for(var i=0;i<500;i++){a.push(i);} var s=new Set(a); return s.size; };`;
// A construction loop: below the gate the Set builds are ~free (call-site gas only)
// and it finishes; above the gate each new Set(a1000) charges 1000, so 2000 rounds
// blow the 500k ceiling -> deterministic out_of_gas.
const setLoop = `module.exports = function(xchain){ var a=[]; for(var i=0;i<1000;i++){a.push(i);} for(var r=0;r<2000;r++){ var s=new Set(a); } return 'done'; };`;

(XChainVM ? describe : describe.skip)('Set/Map ctor metering: per-coin Pkg 3 height gate', function () {
    this.timeout(30000);

    const runAt = (code, height, network, coin, ceiling) => {
        const vm = createVM({ gasCeiling: ceiling || 1000000 });
        vm.beginBlock();
        return execute(vm, code, {
            method: 'default',
            blockContext: { height, timestamp: TS, hash: 'h' },
            network,
            contractAddress: 'C:' + (coin || 'BTC') + ':1',
        }).then((r) => { vm.endBlock(); return r; });
    };

    it('below the BTC gate (960999): Set ctor is UNMETERED (baseline gasUsed)', async function () {
        const r = await runAt(oneSet, 960999, 'mainnet', 'BTC');
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 500);
        this.belowGas = r.gasUsed;
    });

    it('at the BTC gate (961000): the source size is charged (gasUsed strictly higher, by ~size)', async function () {
        const below = await runAt(oneSet, 960999, 'mainnet', 'BTC');
        const at = await runAt(oneSet, 961000, 'mainnet', 'BTC');
        assert.strictEqual(at.success, true, at.error);
        assert.strictEqual(JSON.parse(at.returnValue), 500);
        assert.ok(at.gasUsed > below.gasUsed,
            `metered gasUsed (${at.gasUsed}) must exceed unmetered (${below.gasUsed})`);
        assert.strictEqual(at.gasUsed - below.gasUsed, 500,
            'the charge is exactly the 500-element source length');
    });

    // CHANGED, and the change is deliberate.
    //
    // This asserted that below the Pkg 3 gate a heavy .add() loop SUCCEEDS, because
    // mutation was unmetered and a from-genesis replay had to reproduce historical
    // gas bit-for-bit. #3184 charges Set.add / Map.set UNGATED: construction metering
    // stays behind this per-coin height gate, but GROWTH is charged from genesis,
    // because charging construction while leaving the equivalent loop free left the
    // unbounded-allocation hole wide open on exactly the path an attacker would use.
    //
    // Ungated is only sound inside the coordinated wipe-and-replay batch, whose mandatory fleet-wide
    // wipe-and-replay recomputes all history under the new rules, so there is no
    // historical gas left to preserve. Some already-deployed operator contracts will
    // re-execute more expensively and may now fail; per spec §2 those are findings to
    // adjudicate in the deploy report, not casualties.
    it('below the gate: a heavy .add() loop is ALSO out_of_gas (mutation metering is ungated, #3184)', async function () {
        const r = await runAt(setLoop, 960999, 'mainnet', 'BTC', 500000);
        assert.strictEqual(r.success, false,
            'growth is charged from genesis now: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_gas:|^out_of_resource:/, r.error);
    });

    // The construction gate must NOT have moved. If the mutation charge had leaked
    // into the constructor path, the sibling "charge is exactly the 500-element source
    // length" assertion above would drift, so this pins the separation directly: below
    // the gate a single ctor call is still free.
    it('below the gate: the CONSTRUCTOR is still unmetered (#3184 did not widen the ctor gate)', async function () {
        const below = await runAt(oneSet, 960999, 'mainnet', 'BTC');
        const at    = await runAt(oneSet, 961000, 'mainnet', 'BTC');
        assert.strictEqual(at.gasUsed - below.gasUsed, 500,
            'the ctor charge must still be exactly the source length, unchanged by the ' +
            'mutation metering, or the two gates have been conflated');
    });

    it('at the gate: the same loop is a deterministic out_of_gas (metering binds)', async function () {
        const r = await runAt(setLoop, 961000, 'mainnet', 'BTC', 500000);
        assert.strictEqual(r.success, false, 'metered loop must exhaust gas: ' + JSON.stringify(r.returnValue));
        assert.match(r.error, /^out_of_gas:|^out_of_resource:/, r.error);
    });

    // ---- Per-coin: LTC/DOGE stay unmetered at a bare BTC 961000 ----
    it('LTC mainnet at 961000: Set ctor still unmetered (per-coin fix)', async function () {
        const below = await runAt(oneSet, 960999, 'mainnet', 'LTC');
        const at961 = await runAt(oneSet, 961000, 'mainnet', 'LTC');
        assert.strictEqual(at961.gasUsed, below.gasUsed, 'LTC must not meter at a bare BTC 961000');
    });

    it('LTC mainnet at its proposed height (3154250): Set ctor is metered', async function () {
        const below = await runAt(oneSet, 960999, 'mainnet', 'LTC');
        const atLtc = await runAt(oneSet, 3154250, 'mainnet', 'LTC');
        assert.strictEqual(atLtc.gasUsed - below.gasUsed, 500);
    });

    it('DOGE mainnet: unmetered at 961000, metered at its proposed height (6319000)', async function () {
        const below = await runAt(oneSet, 960999, 'mainnet', 'DOGE');
        const at961 = await runAt(oneSet, 961000, 'mainnet', 'DOGE');
        const atDoge = await runAt(oneSet, 6319000, 'mainnet', 'DOGE');
        assert.strictEqual(at961.gasUsed, below.gasUsed);
        assert.strictEqual(atDoge.gasUsed - below.gasUsed, 500);
    });

    // ---- Map + Weak collections meter too (smoke) ----
    it('Map from a large entry array is metered above the gate', async function () {
        const mapCode = `module.exports = function(xchain){ var e=[]; for(var i=0;i<300;i++){e.push([i,i]);} var m=new Map(e); return m.size; };`;
        const below = await runAt(mapCode, 960999, 'mainnet', 'BTC');
        const at = await runAt(mapCode, 961000, 'mainnet', 'BTC');
        assert.strictEqual(JSON.parse(at.returnValue), 300);
        assert.strictEqual(at.gasUsed - below.gasUsed, 300);
    });

    // ---- Pre-launch nets meter from genesis ----
    it('regtest meters the Set ctor from genesis (height 0)', async function () {
        const belowMain = await runAt(oneSet, 960999, 'mainnet', 'BTC');
        const regtest = await runAt(oneSet, 0, 'regtest', 'BTC');
        // The pre-launch nets are ALSO genesis-active for the execute-time source
        // lint, whose cost is metered as gas, so the regtest run carries one extra charge
        // the mainnet baseline does not. Derive it from the exported divisor rather than
        // hard-coding it, so a re-tuned divisor moves this expectation with it.
        const lintGas = GAS_SCHEDULE.VM_COMPUTATION * Math.max(1, Math.ceil(
            Buffer.byteLength(oneSet, 'utf8') / EXEC_LINT_GAS_BYTES_PER_UNIT));
        assert.strictEqual(regtest.gasUsed - belowMain.gasUsed, 500 + lintGas,
            'regtest must charge the source size from genesis, plus the metered execute-time lint');
    });
});
