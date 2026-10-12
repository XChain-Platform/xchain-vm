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
 ********************************************************************/
// @ts-nocheck
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const sandbox = require('../../../src/sandbox.js');

describe('consensus parameters are frozen (track 8 guard)', function () {
    it('BigInt native strip surface matches the frozen digest', function () {
        const surface = {
            globals: sandbox.BIGINT_SURFACE_STRIPPED_GLOBAL_NAMES,
            prototypeMethods: sandbox.BIGINT_SURFACE_STRIPPED_PROTO_METHODS.map(
                (entry) => entry.proto + '.' + entry.method).sort(),
            prototypeConstructors: sandbox.BIGINT_SURFACE_NEUTERED_PROTO_CONSTRUCTORS
        };
        for (const list of [surface.globals, sandbox.BIGINT_SURFACE_STRIPPED_PROTO_METHODS,
            surface.prototypeConstructors])
            assert.ok(Object.isFrozen(list), 'BigInt strip surface lists must be frozen');
        const digest = crypto.createHash('sha256').update(JSON.stringify(surface)).digest('hex');
        assert.strictEqual(digest, 'a5632be768e615e4356e63bb7dbeb50fbb365d6c5bb6989e4df6f427cc0a1d58');
    });
});
