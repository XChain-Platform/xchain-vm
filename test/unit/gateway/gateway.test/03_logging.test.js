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

const assert = require('assert');
const { build } = require('./helpers/gateway.js');

describe('Gateway (host-function surface)', function () {
    describe('logging', function () {
        it('log stringifies and joins args; counters reflect collector', function () {
            const { gw, collector } = build();
            gw.log('a', 1, { x: 2 });
            assert.strictEqual(collector.logs.length, 1);
            assert.strictEqual(collector.logs[0], 'a 1 [object Object]');
            assert.strictEqual(gw.getLogCount(), 1);
            assert.strictEqual(gw.isLogFull(), false);
            collector.logFull = true;
            assert.strictEqual(gw.isLogFull(), true);
        });
    });
});
