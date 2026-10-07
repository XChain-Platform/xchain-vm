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
// The getSnapshotAge unit is published as consensus seconds in both the
// gateway types and the read-only accessor header.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../../src', rel), 'utf8');

describe('getSnapshotAge unit documentation', function () {
    it('gateway.d.ts documents getSnapshotAge as consensus seconds', function () {
        const dts = read('gateway.d.ts');
        const m = dts.match(/\/\*\*([^*]|\*(?!\/))*\*\/\s*getSnapshotAge\(\): number;/);
        assert.ok(m, 'getSnapshotAge doc comment present');
        assert.match(m[0], /consensus seconds/);
        assert.doesNotMatch(m[0], /[Bb]locks/);
    });

    it('readonly-accessors.js documents snapshotAge as consensus seconds', function () {
        const js = read('readonly-accessors.js');
        assert.match(js, /snapshotAge is in consensus seconds/);
    });
});
