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

const { buildEmitAPI } = require('../../../../../src/gateway_emit.js');
const GasTracker = require('../../../../../src/gas.js');
const EmissionCollector = require('../../../../../src/collector.js');

const SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200,
    VM_STATE_DELETE: 100, VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000,
    VM_EMISSION: 500, VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function createEmitAPI() {
    const gasTracker = new GasTracker(SCHEDULE, 1000000);
    const collector = new EmissionCollector(50);
    const emit = buildEmitAPI(gasTracker, collector, SCHEDULE);
    return { emit, gasTracker, collector };
}

module.exports = { createEmitAPI, SCHEDULE };
