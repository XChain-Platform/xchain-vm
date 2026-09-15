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
    describe('composed APIs are wired in', function () {
        it('exposes emit and math sub-APIs', function () {
            const { gw } = build();
            assert.strictEqual(typeof gw.emit, 'object');
            assert.strictEqual(typeof gw.emit.send, 'function');
            assert.strictEqual(typeof gw.math, 'object');
        });
    });
});
