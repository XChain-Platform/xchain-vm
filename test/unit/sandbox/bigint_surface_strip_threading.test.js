/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/
'use strict';

const assert = require('assert');
const XChainVM = require('../../../src/index.js');

const GAS_SCHEDULE = {
    VM_COMPUTATION: 1, VM_STATE_READ: 100, VM_STATE_WRITE: 200, VM_STATE_DELETE: 100,
    VM_ORACLE_READ: 100, VM_CROSSCHAIN_READ: 100, VM_ATTEST_REQUEST: 5000, VM_EMISSION: 500,
    VM_XCALL_REQUEST: 2000, VM_XCALL_CALLBACK: 20000
};

function newVm() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        execution: 'in-process'
    });
}

const CONTEXT = { height: 10000000, timestamp: 1786060800, hash: 'b'.repeat(64) };
const ADDRESS = 'C:BTC:1';

describe('BigInt surface strip execute threading', function () {
    it('keeps the unarmed public-network surface independent from Package 3', async function () {
        const result = await newVm().execute({
            code: "module.exports = function(){ return [typeof BigInt64Array, typeof BigUint64Array, typeof DataView.prototype.getBigInt64, typeof globalThis['Web' + 'Assembly']]; };",
            state: {}, method: 'default', params: [], caller: 'bc1qcaller',
            contractAddress: ADDRESS, contractIndex: 1, txHash: 'a'.repeat(64),
            blockContext: CONTEXT, network: 'mainnet'
        });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.returnValue, '["function","function","function","undefined"]');
    });

    it('strips the surface on regtest from genesis', async function () {
        const result = await newVm().execute({
            code: "module.exports = function(){ return [typeof BigInt64Array, typeof BigUint64Array, typeof DataView.prototype.getBigInt64, typeof globalThis['Web' + 'Assembly']]; };",
            state: {}, method: 'default', params: [], caller: 'bc1qcaller',
            contractAddress: ADDRESS, contractIndex: 1, txHash: 'a'.repeat(64),
            blockContext: { height: 0, timestamp: 0, hash: 'b'.repeat(64) }, network: 'regtest'
        });

        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.returnValue, '["undefined","undefined","undefined","undefined"]');
    });

    it('uses the deploy context for manifest execution', async function () {
        const code = "module.exports = { permissions: typeof BigInt64Array === 'undefined' ? ['SEND'] : [] };";
        const publicResult = await newVm().readManifest(code, {
            network: 'mainnet', contractAddress: ADDRESS, blockContext: CONTEXT
        });
        const regtestResult = await newVm().readManifest(code, {
            network: 'regtest', contractAddress: ADDRESS,
            blockContext: { height: 0, timestamp: 0, hash: 'b'.repeat(64) }
        });

        assert.strictEqual(publicResult.success, true, publicResult.error);
        assert.strictEqual(regtestResult.success, true, regtestResult.error);
        assert.deepStrictEqual(publicResult.manifest.permissions, []);
        assert.deepStrictEqual(regtestResult.manifest.permissions, ['SEND']);
    });
});
