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

const { assert, GAS_SCHEDULE, vmWorking, createVM, setupVM, execute } = require('./support/index_vm.js');

let vm;
(vmWorking ? describe : describe.skip)('XChainVM', function() {
    before(async function() {
        vm = await setupVM.call(this);
    });

    describe('oracle', function() {
        it('should return price from oracle data', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPrice("BTC/USD"); };',
                { oracleData: { getPrice: (pair) => pair === 'BTC/USD' ? '50000' : null, getSnapshotAge: () => 60, getPriceAtRound: () => null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '50000');
        });

        it('should return null when oracle data is not provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPrice("BTC/USD"); };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return snapshot age', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getSnapshotAge(); };',
                { oracleData: { getPrice: () => null, getSnapshotAge: () => 120, getPriceAtRound: () => null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 120);
        });

        it('should return MAX_SAFE_INTEGER for snapshot age when no oracle', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getSnapshotAge(); };');
            assert.strictEqual(JSON.parse(result.returnValue), Number.MAX_SAFE_INTEGER);
        });

        it('should return price at round', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.oracle.getPriceAtRound("BTC/USD", 5); };',
                { oracleData: { getPrice: () => null, getSnapshotAge: () => 0, getPriceAtRound: (pair, round) => pair === 'BTC/USD' && round === 5 ? '49000' : null } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), '49000');
        });
    });
});
