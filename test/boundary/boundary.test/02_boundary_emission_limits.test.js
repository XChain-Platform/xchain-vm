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
 * XChain VM: Boundary Test Suite
 *
 * Tests the VM at the exact edges of every configurable limit, hardcoded cap,
 * and validation threshold. Each section targets a specific boundary area
 * from the Boundary Testing Plan.
 *
 * Sections:
 *   1. Gas Ceiling Enforcement (G-1 through G-7)
 *   2. Wall-Clock Timeout (T-1 through T-4)
 *   3. Memory Limits (M-1 through M-4)
 *   4. Code Size (CS-1 through CS-6)
 *   5. State Management (S-1 through S-14)
 *   6. Emission Limits (E-1 through E-7)
 *   7. Log Limits (L-1 through L-7)
 *   8. Return Value Truncation (R-1 through R-5)
 *   9. Math Operations (MA-1 through MA-10)
 *  10. Metering & AST Injection (ME-1 through ME-7)
 *  11. Sandbox Escape Boundaries (SB-1 through SB-8)
 *  12. Gateway Parameter Boundaries (GW-1 through GW-9)
 *  13. Emit Action Field Boundaries (EA-1 through EA-8)
 *  14. Compound Interaction Boundaries
 *  15. Determinism at Boundaries
 */
// @ts-nocheck

const assert = require('assert');
const EmissionCollector = require('../../../src/collector.js');

// Boundary group 6: Emission Limits (E-1 through E-7)

describe('Boundary: Emission Limits', function() {

    it('E-1: emit exactly maxEmissions succeeds', function() {
        const ec = new EmissionCollector(5);
        for (let i = 0; i < 5; i++) ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        assert.strictEqual(ec.getActions().length, 5);
    });

    it('E-2: emit maxEmissions + 1 rejects', function() {
        const ec = new EmissionCollector(5);
        for (let i = 0; i < 5; i++) ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' });
        assert.throws(() => ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' }), /emission limit/);
    });

    it('E-3: emit 0 actions succeeds', function() {
        const ec = new EmissionCollector(50);
        assert.strictEqual(ec.getActions().length, 0);
    });

    it('E-4: maxEmissions = 0 rejects first emit', function() {
        const ec = new EmissionCollector(0);
        assert.throws(() => ec.add('SEND', { destination: 'a', tick: 'T', quantity: '1' }), /emission limit/);
    });
});
