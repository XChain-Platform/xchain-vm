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
// The emit-context fallback for the same-chain call limits (used when a
// caller builds the emit API without limits) must come from
// protocol/constants.js, so a gate change to either value cannot leave the
// fallback on the old number. Pinned by source scan and by behaviour.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const PROTO = require('../../../src/protocol/constants.js');
const { buildEmitAPI } = require('../../../src/gateway-emit.js');
const GasTracker = require('../../../src/gas.js');
const EmissionCollector = require('../../../src/collector.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

// An emit API built with only a call depth, so both limits take the fallback.
function emitAtDepth(callDepth) {
    const gasTracker = new GasTracker(SCHEDULE, 1000000);
    return buildEmitAPI(gasTracker, new EmissionCollector(50), SCHEDULE, { callDepth });
}

const call = (gasLimit) => ({ contractIndex: 1, method: 'm', gasLimit });

describe('VM call-limit fallback single-sourcing parity', function () {

    it('the protocol constants are positive safe integers', function () {
        for (const name of ['VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS']) {
            assert.ok(Number.isSafeInteger(PROTO[name]) && PROTO[name] > 0, name + ' is ' + PROTO[name]);
        }
    });

    it('gateway-emit.js declares both limits FROM PROTO and has no literal fallback', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../../src/gateway-emit.js'), 'utf8');
        for (const name of ['VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS']) {
            const re = new RegExp('const\\s+' + name + '\\s*=\\s*PROTO\\.' + name + '\\b');
            assert.ok(re.test(src), 'gateway-emit.js must declare ' + name + ' as PROTO.' + name);
        }
        assert.ok(!/ctx\.(maxCallDepth|minCallGas)\s*:\s*\d/.test(src),
            'gateway-emit.js falls back to a numeric literal for a call limit');
    });

    it('the fallback depth cap is the protocol max call depth', function () {
        emitAtDepth(PROTO.VM_MAX_CALL_DEPTH - 1).execute(call(PROTO.VM_MIN_CALL_GAS));
        assert.throws(() => emitAtDepth(PROTO.VM_MAX_CALL_DEPTH).execute(call(PROTO.VM_MIN_CALL_GAS)),
            /max call depth/);
    });

    it('the fallback gas floor is the protocol min call gas', function () {
        emitAtDepth(0).execute(call(PROTO.VM_MIN_CALL_GAS));
        assert.throws(() => emitAtDepth(0).execute(call(PROTO.VM_MIN_CALL_GAS - 1)), /gasLimit/);
    });
});
