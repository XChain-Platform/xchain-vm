/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM, execute, XChainVM } = require('../../fuzz/helpers/harness.js');
const {
    TOSTRING_SIZE_METER_GATE_BLOCK_TIME,
} = require('../../../src/index/tostring_size_meter.js');
const { ARGUMENT_LENGTH, VECTORS } = require('./helpers/vectors.js');

const BINARY_ALLOC_GATE_BLOCK_TIME =
    (XChainVM && XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME) || 1786060800;
const CONTEXT = {
    height: 100,
    timestamp: BINARY_ALLOC_GATE_BLOCK_TIME,
    hash: 'abc123',
};
const OPTIONS = { method: 'default', network: 'mainnet', blockContext: CONTEXT };

(XChainVM ? describe : describe.skip)('toString size metering below the gate', function () {
    this.timeout(60000);

    let vm;
    beforeEach(function () {
        vm = createVM({ gasCeiling: 1000000, maxCpuTimeMs: 30000 });
        vm.beginBlock();
    });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('uses the binary allocation gate while mainnet remains below the gate', function () {
        assert.ok(BINARY_ALLOC_GATE_BLOCK_TIME < TOSTRING_SIZE_METER_GATE_BLOCK_TIME);
    });

    for (const fn of [...new Set(VECTORS.map((vector) => vector.fn))]) {
        it(`${fn} charges only its primitive string form`, async function () {
            const byForm = Object.create(null);
            for (const vector of VECTORS.filter((entry) => entry.fn === fn)) {
                const result = await execute(vm, vector.code, OPTIONS);
                assert.strictEqual(result.success, true, `${vector.form}: ${result.error}`);
                byForm[vector.form] = result.gasUsed;
            }

            assert.ok(byForm.primitive - byForm['new String'] >= ARGUMENT_LENGTH,
                `${fn}: primitive ${byForm.primitive}, new String ${byForm['new String']}`);
            assert.ok(byForm.primitive - byForm.toString >= ARGUMENT_LENGTH,
                `${fn}: primitive ${byForm.primitive}, toString ${byForm.toString}`);
        });
    }
});
