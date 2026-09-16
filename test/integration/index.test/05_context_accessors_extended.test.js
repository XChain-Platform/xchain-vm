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

    describe('context accessors (extended)', function() {
        it('should provide block timestamp', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBlockTimestamp(); };',
                { blockContext: { height: 100, timestamp: 1700000000, hash: 'abc' } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 1700000000);
        });

        it('should provide block hash', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getBlockHash(); };',
                { blockContext: { height: 100, timestamp: 1700000000, hash: 'myhash' } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 'myhash');
        });

        it('should provide input param count', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParamCount(); };',
                { params: ['a', 'b', 'c'] }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 3);
        });

        it('should return null for out-of-bounds getInputParam', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParam(5); };',
                { params: ['a', 'b'] }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return 0 for getInputParamCount with no params', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.getInputParamCount(); };',
                { params: [] }
            );
            assert.strictEqual(JSON.parse(result.returnValue), 0);
        });
    });
});
