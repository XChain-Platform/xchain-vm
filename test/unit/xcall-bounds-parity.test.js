// @ts-nocheck
//
// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// 5db7dc60 (flag-day Pkg 4 / , verify-only): the XCALL gas/deadline
// bounds exported from index.js and the copies the gateway-emit enforcer
// compares against must all be single-sourced from protocol/constants.js so
// the exported/parity-tested values can never drift from the enforced ones.
// At HEAD they already are; these tests pin that single-sourcing.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const PROTO = require('../../src/protocol/constants.js');

let vm = null;
try {
    vm = require('../../src/index.js'); // requires isolated-vm (Node 22 / Linux)
} catch (e) { /* covered by the source-scan tests below */ }

const BOUNDS = ['XCALL_MIN_GAS', 'XCALL_MAX_GAS', 'XCALL_MIN_DEADLINE_BLOCKS',
                'XCALL_MAX_DEADLINE_BLOCKS'];

describe('XCALL bounds single-sourcing parity (5db7dc60)', function () {

    (vm ? it : it.skip)('index.js exports equal the protocol constants exactly', function () {
        for (const name of BOUNDS.concat(['XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES'])) {
            assert.strictEqual(vm[name], PROTO[name],
                name + ' export drifted from protocol/constants.js');
        }
    });

    (vm ? it : it.skip)('gateway-emit exports the hop bound from the same source', function () {
        const emit = require('../../src/gateway-emit.js');
        assert.strictEqual(emit.XCALL_MAX_HOPS, PROTO.XCALL_MAX_HOPS);
    });

    it('the enforcer (gateway-emit.js) declares every bound FROM PROTO, never as a literal', function () {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'gateway-emit.js'), 'utf8');
        for (const name of BOUNDS.concat(['XCALL_MAX_HOPS'])) {
            const re = new RegExp('const\\s+' + name + '\\s*=\\s*PROTO\\.' + name + '\\b');
            assert.ok(re.test(src),
                'gateway-emit.js must declare ' + name + ' as PROTO.' + name +
                ' (a re-declared literal can drift from the exported/parity-tested value)');
        }
    });

    it('index.js declares the four bounds FROM PROTO too (no literal re-declaration)', function () {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
        for (const name of BOUNDS) {
            const re = new RegExp('const\\s+' + name + '\\s*=\\s*PROTO\\.' + name + '\\b');
            assert.ok(re.test(src), 'index.js must declare ' + name + ' as PROTO.' + name);
        }
    });
});
