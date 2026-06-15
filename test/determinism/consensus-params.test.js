/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Consensus-parameter FREEZE guard (LAUNCH-PLAN track 8).
 *
 * The VM half of the frozen consensus surface: the declared CONSENSUS_VERSION,
 * the pinned runtime, and the status vocabulary. These are golden literals —
 * any drift reddens here, and a real change must bump CONSENSUS_VERSION + a new
 * golden in BOTH repos (the indexer asserts the bundled VM's version) and, post-
 * launch, a protocol_changes.js block-height activation. See
 * claude/reports/launch/CONSENSUS-ACTIVATION-RUNBOOK.md.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const cr = require('../../src/consensus-runtime');
const vm = require('../../src/index');

describe('consensus parameters are frozen (track 8 guard)', function () {

    it('CONSENSUS_VERSION is the declared epoch (bump = consensus event)', function () {
        assert.strictEqual(cr.CONSENSUS_VERSION, '1');
        assert.strictEqual(vm.CONSENSUS_VERSION, '1', 're-export must match');
    });

    it('PINNED runtime equals the golden (re-pinning is a consensus event)', function () {
        assert.deepStrictEqual(cr.PINNED, {
            v8:      '12.4.254.21-node.56',
            icu:     '78.2',
            unicode: '17.0',
            cldr:    '48.0',
            modules: '127'
        });
        assert.ok(Object.isFrozen(cr.PINNED));
    });

    it('CONSENSUS_STATUS_TOKENS is the frozen closed set (resource family collapsed)', function () {
        assert.deepStrictEqual(cr.CONSENSUS_STATUS_TOKENS, ['reverted', 'out_of_resource', 'failed']);
        assert.ok(Object.isFrozen(cr.CONSENSUS_STATUS_TOKENS));
        assert.deepStrictEqual(vm.CONSENSUS_STATUS_TOKENS, cr.CONSENSUS_STATUS_TOKENS, 're-export must match');
    });

    it('BINARY_ALLOC_GATE_BLOCK_TIME is the frozen flag-day (a divergent value forks the fleet)', function () {
        // The F3-binary ArrayBuffer/TypedArray byte-length gas charge activates
        // fleet-wide at this block time. It is hashed (gasUsed → contract_hash) and
        // drives the fee debit, so two nodes that disagree on the flag day diverge
        // on the first binary-allocating execution after the earlier of the two.
        // Pin it like any other consensus parameter; changing it is a coordinated
        // release-team event, NOT a silent edit. Matches the indexer's other 2.0.0
        // flag-day activations (protocol_changes.js: 1798761600).
        assert.strictEqual(vm.BINARY_ALLOC_GATE_BLOCK_TIME, 1798761600);
    });

    it('STATUS_ERROR_PREFIXES documents every raw prefix the VM can emit', function () {
        assert.deepStrictEqual(cr.STATUS_ERROR_PREFIXES,
            ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']);
        assert.ok(Object.isFrozen(cr.STATUS_ERROR_PREFIXES));
        // The whole resource-exhaustion family the indexer collapses to
        // 'out_of_resource' must be covered, plus the revert / generic prefixes.
        for (const p of ['revert', 'out_of_gas', 'timeout', 'out_of_memory', 'out_of_stack', 'out_of_resource', 'error']) {
            assert.ok(cr.STATUS_ERROR_PREFIXES.includes(p), 'missing prefix: ' + p);
        }
    });
});
