/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Determinism corpus runner.
 *
 * Executes every scenario and returns a portable, sorted result list:
 *   { id, tier, hash, success, error, gasUsed, hazard? }
 *
 * `hash` is the full sha256 of the normalized execution result (see
 * fuzz/harness.hashResult). Two machines that produce the same hash for
 * the same id agree byte-for-byte on the consensus-visible output.
 ********************************************************************/
// @ts-nocheck


const os = require('os');
const { createVM, execute, hashResult, XChainVM } = require('../fuzz/harness');
const { SCENARIOS, BLOCK } = require('./scenarios');

function platformTag() {
    const major = process.versions.node.split('.')[0];
    return `${os.arch()}-node${major}-v8_${process.versions.v8}`;
}

async function runOne(vm, sc) {
    const result = await execute(vm, sc.code, {
        method: sc.method,
        params: sc.params,
        state: sc.state || {},
        blockContext: BLOCK,
        oracleData: sc.oracleData,
        crossChainData: sc.crossChainData,
        contractIndex: 1
    });
    const entry = {
        id: sc.id,
        tier: sc.tier,
        hash: hashResult(result),
        success: result.success,
        error: result.error,
        gasUsed: result.gasUsed
    };
    if (sc.hazard) entry.hazard = sc.hazard;
    return entry;
}

async function runAll() {
    if (!XChainVM) {
        const err = new Error('isolated-vm not available — cannot run determinism corpus');
        err.code = 'NO_ISOLATED_VM';
        throw err;
    }
    const entries = [];
    for (const sc of SCENARIOS) {
        // Fresh VM per scenario: each scenario must be self-contained and
        // free of cross-scenario block-cache / state bleed.
        const vm = createVM();
        if (typeof vm.beginBlock === 'function') vm.beginBlock();
        entries.push(await runOne(vm, sc));
        if (typeof vm.endBlock === 'function') vm.endBlock();
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { platform: platformTag(), entries };
}

module.exports = { runAll, platformTag };
