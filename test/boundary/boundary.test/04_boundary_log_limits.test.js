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

// Boundary group 7: Log Limits (L-1 through L-7)

describe('Boundary: Log Limits', function() {

    it('L-1: log exactly 100 entries', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 100; i++) ec.addLog('msg ' + i);
        assert.strictEqual(ec.getLogs().length, 100);
        assert.strictEqual(ec.isLogFull(), true);
    });

    it('L-2: log 101 entries drops 101st', function() {
        const ec = new EmissionCollector(50);
        for (let i = 0; i < 101; i++) ec.addLog('msg ' + i);
        assert.strictEqual(ec.getLogs().length, 100);
    });

    it('L-3: log entry at exactly 1024 bytes preserved', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1024);
        assert.strictEqual(Buffer.byteLength(msg, 'utf8'), 1024);
        ec.addLog(msg);
        assert.strictEqual(ec.getLogs()[0].length, 1024);
        assert(!ec.getLogs()[0].includes('truncated'));
    });

    it('L-4: log entry at 1025 bytes truncated', function() {
        const ec = new EmissionCollector(50);
        const msg = 'x'.repeat(1025);
        ec.addLog(msg);
        assert(ec.getLogs()[0].endsWith('...(truncated)'));
    });

    it('L-5: empty string log preserved', function() {
        const ec = new EmissionCollector(50);
        ec.addLog('');
        assert.strictEqual(ec.getLogs()[0], '');
    });

    it('L-7: multi-byte characters truncated by byte length', function() {
        const ec = new EmissionCollector(50);
        // 256 emojis * 4 bytes = 1024 bytes exactly
        const emoji = '\u{1F600}';
        const atLimit = emoji.repeat(256);
        assert.strictEqual(Buffer.byteLength(atLimit, 'utf8'), 1024);
        ec.addLog(atLimit);
        assert(!ec.getLogs()[0].includes('truncated'), 'exactly 1024 bytes should not truncate');

        // 257 emojis = 1028 bytes
        const overLimit = emoji.repeat(257);
        ec.addLog(overLimit);
        assert(ec.getLogs()[1].includes('...(truncated)'), 'over 1024 bytes should truncate');
    });
});
