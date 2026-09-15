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
const { createVM, execute } = require('../helpers/harness.js');

describe('[P2] Functional Regression', function() {
    // FULL EMIT PIPELINE (integration through VM)
    describe('Full emit pipeline through VM', function() {

        let vm;
        before(function() { vm = createVM(); });

        it('should emit all 16 types through real execution', async function() {
            const r = await execute(vm, `
                module.exports = function(xchain) {
                    xchain.emit.send({ destination: 'a', tick: 'T', quantity: '1' });
                    xchain.emit.destroy({ tick: 'T', quantity: '1' });
                    xchain.emit.issue({ tick: 'N' });
                    xchain.emit.mint({ tick: 'T', quantity: '1' });
                    xchain.emit.order({ giveAmount: '1', getAmount: '1' });
                    xchain.emit.dispenser({ tick: 'T' });
                    xchain.emit.dividend({ tick: 'T', dividendTick: 'D', quantity: '1' });
                    xchain.emit.airdrop({ tick: 'T', quantity: '1', listActionIndex: 1 });
                    xchain.emit.callback({ tick: 'T' });
                    xchain.emit.file({ data: 'x' });
                    xchain.emit.list({ items: ['a'] });
                    xchain.emit.coinpay({ orderMatchActionIndex: 1 });
                    xchain.emit.sweep({ destination: 'a' });
                    xchain.emit.link({ coin1: 'B', coin1ActionIndex: 1, coin2: 'D', coin2ActionIndex: 2 });
                    xchain.emit.broadcast({ data: 'm' });
                    xchain.emit.message({ destination: 'a', body: 'h' });
                    return 'all emitted';
                };
            `);
            assert.strictEqual(r.success, true);
            assert.strictEqual(r.emittedActions.length, 16);
            const types = r.emittedActions.map(a => a.action);
            assert(types.includes('SEND'));
            assert(types.includes('DESTROY'));
            assert(types.includes('ISSUE'));
            assert(types.includes('MINT'));
            assert(types.includes('ORDER'));
            assert(types.includes('DISPENSER'));
            assert(types.includes('DIVIDEND'));
            assert(types.includes('AIRDROP'));
            assert(types.includes('CALLBACK'));
            assert(types.includes('FILE'));
            assert(types.includes('LIST'));
            assert(types.includes('COINPAY'));
            assert(types.includes('SWEEP'));
            assert(types.includes('LINK'));
            assert(types.includes('BROADCAST'));
            assert(types.includes('MESSAGE'));
        });
    });
});
