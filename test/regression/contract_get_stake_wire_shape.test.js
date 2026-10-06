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
 **********************************************************************
 * contract.getStake wire shape (regression)
 *
 * gateway.d.ts declares getStake as returning a decimal string. A snapshot
 * accessor that returns a BigNumber would cross the isolate bridge as a JSON
 * object, so a contract would read a different type than declared. This runs a
 * contract that calls getStake through the VM and pins the string shape.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { createVM } = require('./helpers/harness.js');
const { makeBigNumberStakeData, makeContractStakeData, PK_A, PK_B } = require('./helpers/contract_host_fixtures.js');

let XChainVM;
try { XChainVM = require('../../src/index.js'); } catch (e) { XChainVM = null; }

const code = (pk, token) => `module.exports = function(xchain) {
    var v = xchain.contract.getStake('${pk}', '${token}');
    return { type: typeof v, value: v };
};`;

const run = (vm, source, contractStakeData) => vm.execute({
    code: source,
    state: {},
    method: 'default',
    params: [],
    caller: 'regression_test_addr',
    contractAddress: 'C:BTC:100',
    contractIndex: 100,
    blockContext: { height: 1000, timestamp: 1700000000, hash: 'regression_hash' },
    contractStakeData
});

(XChainVM ? describe : describe.skip)('contract.getStake wire shape (regression)', function () {
    this.timeout(30000);

    let vm;
    beforeEach(function () { vm = createVM(); vm.beginBlock(); });
    afterEach(function () { if (vm && vm.endBlock) vm.endBlock(); });

    it('a BigNumber stake reaches the contract as a decimal string', async function () {
        const res = await run(vm, code(PK_A, 'TOKENX'), makeBigNumberStakeData());
        assert.strictEqual(res.success, true, res.error);
        assert.deepStrictEqual(JSON.parse(res.returnValue), { type: 'string', value: '1500' });
    });

    it('an 18-decimal BigNumber stake keeps every digit', async function () {
        const res = await run(vm, code(PK_B, 'TOKENX'), makeBigNumberStakeData());
        assert.strictEqual(res.success, true, res.error);
        assert.deepStrictEqual(JSON.parse(res.returnValue), { type: 'string', value: '0.000000000000000001' });
    });

    it('a BigNumber zero stake is the string "0"', async function () {
        const res = await run(vm, code(PK_A, 'OTHER'), makeBigNumberStakeData());
        assert.strictEqual(res.success, true, res.error);
        assert.deepStrictEqual(JSON.parse(res.returnValue), { type: 'string', value: '0' });
    });

    it('a string stake passes through byte-identical', async function () {
        const res = await run(vm, code(PK_A, 'TOKENX'), makeContractStakeData());
        assert.strictEqual(res.success, true, res.error);
        assert.deepStrictEqual(JSON.parse(res.returnValue), { type: 'string', value: '1500.00000000' });
    });

    it('no accessor yields the string "0"', async function () {
        const res = await run(vm, code(PK_A, 'TOKENX'), undefined);
        assert.strictEqual(res.success, true, res.error);
        assert.deepStrictEqual(JSON.parse(res.returnValue), { type: 'string', value: '0' });
    });
});
