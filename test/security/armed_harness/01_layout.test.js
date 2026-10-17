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
 * Harness selection: every combination of the harness activations derives a
 * harness that keeps each unarmed line at its number, the empty combination is
 * HARNESS_SOURCE itself, and mainnet and testnet select it today.
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { HARNESS_SOURCE } = require('../../../src/index/runtime/harness_source.js');
const { deriveHarness } = require('../../../src/index/armed_harness/derivation.js');
const select = require('../../../src/index/armed_harness/select.js');
const hostCallBounds = require('../../../src/index/armed_harness/host_call_bounds.js');
const stringifyReentry = require('../../../src/index/armed_harness/json_stringify_reentry.js');
const perElementMeter = require('../../../src/index/armed_harness/per_element_meter.js');
const hostErrorStackStrip = require('../../../src/index/armed_harness/host_error_stack_strip.js');

// HARNESS_SOURCE as released: line count and sha256.
const RELEASED_LINES = 1631;
const RELEASED_SHA256 = 'b6b49ddc0b95da4724b337fcf9482d9bb3f1ac0da02c6b0e8758773e6622c748';

const bit = (rule) => 1 << select.RULES.indexOf(rule);
const lines = (s) => s.split('\n');

// Unarmed lines (closing line excluded) that differ in a derived harness.
function editedLines(source) {
    const base = lines(HARNESS_SOURCE), armed = lines(source);
    const out = [];
    for (let i = 0; i < base.length - 2; i++) if (base[i] !== armed[i]) out.push(i);
    return out;
}

describe('armed harness selection: layout', function () {
    it('the unarmed harness is the released HARNESS_SOURCE, byte for byte', function () {
        assert.strictEqual(select.harnessSourceFor(0), HARNESS_SOURCE);
        assert.strictEqual(lines(HARNESS_SOURCE).length, RELEASED_LINES);
        assert.strictEqual(crypto.createHash('sha256').update(HARNESS_SOURCE).digest('hex'), RELEASED_SHA256);
    });

    it('every combination keeps each unarmed line at its number and edits exactly its rules\' lines', function () {
        const single = select.RULES.map((rule) => new Set(editedLines(select.harnessSourceFor(bit(rule)))));
        const base = lines(HARNESS_SOURCE);
        for (let mask = 1; mask < 1 << select.RULES.length; mask++) {
            const source = select.harnessSourceFor(mask);
            const armed = lines(source);
            assert.ok(armed.length >= base.length, 'mask ' + mask);
            assert.deepStrictEqual(armed.slice(-2), base.slice(-2), 'mask ' + mask + ' closing line');
            const want = [];
            single.forEach((set, i) => { if (mask & (1 << i)) want.push(...set); });
            assert.deepStrictEqual(editedLines(source), want.sort((a, b) => a - b), 'mask ' + mask);
        }
    });

    it('a rule armed alone derives exactly its own harness', function () {
        assert.strictEqual(select.harnessSourceFor(bit(hostCallBounds)), hostCallBounds.HARNESS_SOURCE_HOST_CALL_BOUNDS);
        assert.strictEqual(select.harnessSourceFor(bit(stringifyReentry)), stringifyReentry.HARNESS_SOURCE_STRINGIFY_REENTRY);
        assert.strictEqual(select.harnessSourceFor(bit(perElementMeter)), perElementMeter.HARNESS_SOURCE_PER_ELEMENT_METER);
    });

    it('the host-call bounds allowance reaches the re-entrant stringify wrapper and __wrapArmed only beside it', function () {
        const take = 'var allowance = __hostArgDepthAllowance; __hostArgDepthAllowance = 0;';
        assert.ok(!select.harnessSourceFor(bit(stringifyReentry)).includes(take));
        const both = select.harnessSourceFor(bit(stringifyReentry) | bit(hostCallBounds));
        const wrapper = both.slice(both.indexOf('function __rsfStringifyReentrant'));
        assert.ok(wrapper.includes(take));
        assert.ok(wrapper.includes('__resolveForStringify(value, arguments[1], allowance)'));

        const lend = '__hostArgDepthAllowance = 1;';
        const alone = select.harnessSourceFor(bit(hostErrorStackStrip));
        assert.ok(!alone.slice(alone.indexOf('function __wrapArmed')).includes(lend));
        const paired = select.harnessSourceFor(bit(hostErrorStackStrip) | bit(hostCallBounds));
        assert.ok(paired.slice(paired.indexOf('function __wrapArmed')).includes(lend));
    });

    it('refuses two rules that edit the same harness line', function () {
        const from = '    var __stackPoison  = false;\n';
        const rule = (label, tail) => ({ label, edits: [[from, from.replace('\n', tail + '\n')]], helpers: '' });
        assert.throws(() => deriveHarness(HARNESS_SOURCE, [rule('a', ' /*a*/'), rule('b', ' /*b*/')]),
            /edited by both a and b/);
    });

});
