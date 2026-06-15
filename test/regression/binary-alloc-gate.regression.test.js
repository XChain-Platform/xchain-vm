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
 * Binary-allocation gas-metering activation gate (regression)
 *
 * The F3-binary charge — ArrayBuffer/TypedArray construction costs its byte
 * length in gas — is a consensus-affecting gas-schedule change: gasUsed is hashed
 * into the per-block contract checkpoint and drives the fee debit. Applied to
 * ALL blocks it would fork any mixed-version fleet on the first binary-allocating
 * execution (a node with the charge out_of_gas-reverts where a node without it
 * succeeds cheaply → divergent gasUsed, divergent outcome, divergent hash).
 *
 * The charge is therefore gated on a coordinated block-time flag-day
 * (XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME): unmetered below it (matching
 * pre-activation nodes), byte-proportional at/after it. This fixture pins BOTH
 * schedule versions and the switch between them, so a future edit that drops the
 * gate (re-enabling the charge on historical blocks) or shifts the flag day
 * reddens here instead of silently splitting the fleet.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../fuzz/harness');

const CEILING = 1000000;
const GATE = (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1798761600;

// One second on either side of the flag day isolates the gate boundary itself.
const BEFORE = { height: 100, timestamp: GATE - 1, hash: 'pre' };
const AT     = { height: 100, timestamp: GATE,     hash: 'at'  };

(XChainVM ? describe : describe.skip)('binary-alloc metering activation gate (regression)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    const run = (code, blockContext) => execute(vm, code, { method: 'default', blockContext });

    it('the flag day is the pinned coordinated activation timestamp', function () {
        assert.strictEqual(GATE, 1798761600);
    });

    it('(a) the same binary allocation produces a DIFFERENT gasUsed below vs at the flag day', async function () {
        // 50 KiB is comfortably under the gas ceiling AND the isolate memory limit,
        // so it succeeds on BOTH sides — the only difference is the byte-length
        // charge. This is the exact divergence that forks a mixed-version fleet.
        const code = `module.exports = function(){ var a = new Uint8Array(50000); return a.length; };`;

        const lo = await run(code, BEFORE);
        const hi = await run(code, AT);

        assert.strictEqual(lo.success, true, 'below the flag day the allocation is unmetered and succeeds: ' + lo.error);
        assert.strictEqual(hi.success, true, 'at the flag day a 50 KiB allocation is well under the ceiling: ' + hi.error);
        assert.strictEqual(lo.returnValue, '50000');
        assert.strictEqual(hi.returnValue, '50000');

        // (b) the at/after run carries the byte-proportional charge; the below run
        //     does not (the construction costs only the flat AST-meter gas).
        assert.ok(hi.gasUsed >= 50000, 'at the flag day gasUsed must include the ~50000-byte charge, got ' + hi.gasUsed);
        assert.ok(lo.gasUsed < 50000, 'below the flag day the byte charge must be absent, got ' + lo.gasUsed);
        assert.ok(hi.gasUsed > lo.gasUsed, 'gasUsed must differ across the gate (' + lo.gasUsed + ' vs ' + hi.gasUsed + ')');
    });

    it('(c) an allocation that out_of_gas-reverts AT the flag day SUCCEEDS below it (opposite outcomes)', async function () {
        // 2 MiB: above the 1,000,000 gas ceiling once charged by byte length, but
        // well under the 8 MiB isolate memory limit. At/after the flag day the
        // byte charge trips the gas ceiling (uncatchable out_of_gas); below it the
        // allocation is unmetered and the contract returns normally. Opposite
        // consensus outcomes for the identical contract — the fork the gate exists
        // to prevent from landing on historical blocks.
        const code = `module.exports = function(){ var a = new Uint8Array(2000000); return a.length; };`;

        const lo = await run(code, BEFORE);
        const hi = await run(code, AT);

        assert.strictEqual(lo.success, true, 'below the flag day the 2 MiB allocation is unmetered and succeeds: ' + lo.error);
        assert.strictEqual(lo.returnValue, '2000000');

        assert.strictEqual(hi.success, false, 'at the flag day the byte charge must trip the gas ceiling');
        assert.match(hi.error, /^out_of_gas:/, 'must be an uncatchable out_of_gas, got: ' + hi.error);
        assert.strictEqual(hi.gasUsed, CEILING, 'gasUsed clamps to the ceiling (fee-bounded, hashed)');
    });

    it('the gate covers every binary constructor, not just Uint8Array', async function () {
        // Float64Array (8 bytes/element): 200k elements = 1.6 MB of charge > ceiling
        // at/after the flag day, unmetered (and tiny) below it.
        const code = `module.exports = function(){ var a = new Float64Array(200000); return a.length; };`;

        const lo = await run(code, BEFORE);
        const hi = await run(code, AT);

        assert.strictEqual(lo.success, true, 'below the flag day: unmetered, succeeds: ' + lo.error);
        assert.strictEqual(lo.returnValue, '200000');
        assert.strictEqual(hi.success, false, 'at the flag day: byte-length charge (200000*8) exceeds the ceiling');
        assert.match(hi.error, /^out_of_gas:/, hi.error);
    });
});
