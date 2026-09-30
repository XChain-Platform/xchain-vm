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
 * [P2] Core Functional Regression Tests
 *
 * Gas metering injection, state operations, all 16 emit types,
 * deterministic math, syntax and action validation.
 *
 * Run: npm run test:regression:full
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const { GAS_SCHEDULE } = require('../helpers/harness.js');
const { buildEmitAPI } = require('../../../src/gateway-emit.js');
const GasTracker = require('../../../src/gas.js');
const EmissionCollector = require('../../../src/collector.js');

function createEmit() {
    const gt = new GasTracker(GAS_SCHEDULE, 1000000);
    const col = new EmissionCollector(50);
    const emit = buildEmitAPI(gt, col, GAS_SCHEDULE);
    return { emit, col, gt };
}

describe('[P2] Functional Regression', function() {
    // ALL 16 EMIT TYPES
    describe('All 16 emit types', function() {

        const EMIT_TESTS = [
            { method: 'send',      params: { destination: 'a', tick: 'T', quantity: '1' },         action: 'SEND' },
            { method: 'destroy',   params: { tick: 'T', quantity: '1' },                           action: 'DESTROY' },
            { method: 'issue',     params: { tick: 'NEW' },                                        action: 'ISSUE' },
            { method: 'mint',      params: { tick: 'T', quantity: '1' },                           action: 'MINT' },
            { method: 'order',     params: { giveAmount: '100', getAmount: '50' },                 action: 'ORDER' },
            { method: 'dispenser', params: { tick: 'T' },                                          action: 'DISPENSER' },
            { method: 'dividend',  params: { tick: 'T', dividendTick: 'D', quantity: '1' },        action: 'DIVIDEND' },
            { method: 'airdrop',   params: { tick: 'T', quantity: '1', listActionIndex: 5 },       action: 'AIRDROP' },
            { method: 'callback',  params: { tick: 'T' },                                          action: 'CALLBACK' },
            { method: 'file',      params: { data: 'x' },                                         action: 'FILE' },
            { method: 'list',      params: { items: ['a'] },                                       action: 'LIST' },
            { method: 'coinpay',   params: { orderMatchActionIndex: 1 },                           action: 'COINPAY' },
            { method: 'sweep',     params: { destination: 'a' },                                   action: 'SWEEP' },
            { method: 'link',      params: { coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 }, action: 'LINK' },
            { method: 'broadcast', params: { data: 'msg' },                                        action: 'BROADCAST' },
            { method: 'message',   params: { destination: 'a', body: 'hi' },                       action: 'MESSAGE' }
        ];

        for (const { method, params, action } of EMIT_TESTS) {
            it(`should queue ${action} via emit.${method}()`, function() {
                const { emit, col } = createEmit();
                emit[method](params);
                assert.strictEqual(col.getActions()[0].action, action);
            });
        }

        it('should charge VM_EMISSION gas per emit', function() {
            const { emit, gt } = createEmit();
            emit.send({ destination: 'a', tick: 'T', quantity: '1' });
            assert.strictEqual(gt.getUsed(), GAS_SCHEDULE.VM_EMISSION);
        });
    });
});

describe('[P2] Functional Regression', function() {
    // ALL 16 EMIT TYPES
    describe('All 16 emit types', function() {

        // Required field validation for critical types
        it('should reject send without destination', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ tick: 'T', quantity: '1' }), /destination/);
        });

        it('should reject send without tick', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ destination: 'a', quantity: '1' }), /tick/);
        });

        it('should reject send without quantity', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send({ destination: 'a', tick: 'T' }), /quantity/);
        });

        it('should reject non-object params', function() {
            const { emit } = createEmit();
            assert.throws(() => emit.send('string'), /params must be an object/);
            assert.throws(() => emit.send(null), /params must be an object/);
        });
    });
});
