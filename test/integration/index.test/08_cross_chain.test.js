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

    describe('crossChain', function() {
        it('should return attestation', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("BTC", 42); };',
                { crossChainData: { getAttestation: (chain, idx) => chain === 'BTC' && idx === 42 ? { status: 'confirmed' } : null, isSettled: () => false } }
            );
            const val = JSON.parse(result.returnValue);
            assert.strictEqual(val.status, 'confirmed');
        });

        it('should return null for missing attestation', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("DOGE", 1); };',
                { crossChainData: { getAttestation: () => null, isSettled: () => false } }
            );
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return null when no crossChainData provided', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.getAttestation("BTC", 1); };');
            assert.strictEqual(result.returnValue, 'null');
        });

        it('should return isSettled boolean', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.isSettled("BTC", 42); };',
                { crossChainData: { getAttestation: () => null, isSettled: (chain, idx) => chain === 'BTC' && idx === 42 } }
            );
            assert.strictEqual(JSON.parse(result.returnValue), true);
        });

        it('should return false for isSettled when no crossChainData', async function() {
            const result = await execute(vm,
                'module.exports = function(xchain) { return xchain.crossChain.isSettled("BTC", 1); };');
            assert.strictEqual(JSON.parse(result.returnValue), false);
        });
    });
});
