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

    describe('emit all 16 action types (integration)', function() {
        const emitTests = [
            { method: 'send', params: "{ destination: 'a', tick: 'T', quantity: '1' }", action: 'SEND' },
            { method: 'destroy', params: "{ tick: 'T', quantity: '1' }", action: 'DESTROY' },
            { method: 'issue', params: "{ tick: 'NEW' }", action: 'ISSUE' },
            { method: 'mint', params: "{ tick: 'T', quantity: '1' }", action: 'MINT' },
            { method: 'order', params: "{ giveAmount: '10', getAmount: '5' }", action: 'ORDER' },
            { method: 'dispenser', params: "{ tick: 'T' }", action: 'DISPENSER' },
            { method: 'dividend', params: "{ tick: 'T', dividendTick: 'D', quantity: '1' }", action: 'DIVIDEND' },
            { method: 'airdrop', params: "{ tick: 'T', quantity: '1', listActionIndex: 1 }", action: 'AIRDROP' },
            { method: 'callback', params: "{ tick: 'T' }", action: 'CALLBACK' },
            { method: 'file', params: "{ data: 'x' }", action: 'FILE' },
            { method: 'list', params: "{ items: [] }", action: 'LIST' },
            { method: 'coinpay', params: "{ orderMatchActionIndex: 1 }", action: 'COINPAY' },
            { method: 'sweep', params: "{ destination: 'a' }", action: 'SWEEP' },
            { method: 'link', params: "{ coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }", action: 'LINK' },
            { method: 'broadcast', params: "{ data: 'x' }", action: 'BROADCAST' },
            { method: 'message', params: "{ destination: 'a', body: 'hi' }", action: 'MESSAGE' }
        ];

        for (const { method, params, action } of emitTests) {
            it('should emit ' + action + ' via xchain.emit.' + method, async function() {
                const code = `module.exports = function(xchain) { xchain.emit.${method}(${params}); };`;
                const result = await execute(vm, code);
                assert.strictEqual(result.success, true, 'emit.' + method + ' failed: ' + result.error);
                assert.strictEqual(result.emittedActions.length, 1);
                assert.strictEqual(result.emittedActions[0].action, action);
            });
        }
    });
});
