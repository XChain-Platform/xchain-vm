/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Ties the four runtime pins to the consensus epoch that froze them.
 *
 * Each pin already has a golden of its own, but a golden moves with its pin in
 * one edit and CONSENSUS_VERSION never has to change. This test keys one digest
 * of all four pins by epoch, and the indexer's VM coupling test holds the same
 * digest for the epoch it expects, so a re-pin at an unchanged epoch reddens in
 * both repos instead of passing as a same-file golden edit.
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const cr = require('../../../src/consensus-runtime.js');

// Record one row per epoch. A new epoch adds its row; a row once recorded is never edited.
const PIN_DIGEST_BY_EPOCH = Object.freeze({
    '7': 'e9520c7a8baeefc28ff2d8d1e1ec08917e0150581d1c4bdc676636bdb5280ae4'
});

// Serialize with sorted keys, so reordering a pin object is not read as a re-pin.
function canonical(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return '{' + Object.keys(value).sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

// Hash the four pin objects the indexer's coupling test hashes the same way.
function runtimePinDigest(runtime) {
    const pins = {
        AST_TOOLCHAIN_PINNED: runtime.AST_TOOLCHAIN_PINNED,
        MATH_PINNED:          runtime.MATH_PINNED,
        PINNED:               runtime.PINNED,
        RUNTIME_ADDON_PINNED: runtime.RUNTIME_ADDON_PINNED
    };
    return crypto.createHash('sha256').update(canonical(pins)).digest('hex');
}

describe('consensus parameters are frozen (track 8 guard)', function () {
    it('the four runtime pins hash to the digest recorded for the current epoch (re-pinning is a consensus event)', function () {
        for (const name of ['PINNED', 'MATH_PINNED', 'AST_TOOLCHAIN_PINNED', 'RUNTIME_ADDON_PINNED'])
            assert.ok(cr[name] && Object.isFrozen(cr[name]), name + ' must be a frozen pin object');
        const recorded = PIN_DIGEST_BY_EPOCH[cr.CONSENSUS_VERSION];
        assert.ok(recorded, 'no runtime pin digest recorded for epoch ' + cr.CONSENSUS_VERSION +
            ': add its row to PIN_DIGEST_BY_EPOCH here and in the indexer VM coupling test');
        assert.strictEqual(runtimePinDigest(cr), recorded,
            'a runtime pin changed under epoch ' + cr.CONSENSUS_VERSION + ': re-pinning is a consensus event, ' +
            'so bump CONSENSUS_VERSION and the indexer EXPECTED_VM_CONSENSUS_VERSION and add a new row');
    });
});
