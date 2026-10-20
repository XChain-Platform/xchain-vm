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
// @ts-nocheck

const assert = require('assert');
const { ContractSimulator } = require('../../src/toolkit/simulator.js');
const { LINT_NESTING_DEPTH_HEIGHTS } = require('../../src/toolkit/simulator/constants.js');

// 70 nested parentheses: past the 64-level delimiter bound and well inside every other rule.
const NESTED = 'module.exports = function () { return ' + '('.repeat(70) + '1' + ')'.repeat(70) + '; };';
const ARMED = LINT_NESTING_DEPTH_HEIGHTS['BTC:testnet'];

describe('toolkit: simulator delimiter-nesting deploy gate', function () {
    this.timeout(30000);

    it('enforces delimiter nesting at deploy only where the indexer has armed it', async function () {
        // Below its height the indexer passes enforceLintNestingDepth false and accepts the DEPLOY.
        const cases = [
            { network: 'mainnet', height: 99999999, expected: false },
            { network: 'testnet', height: ARMED - 1, expected: false },
            { network: 'testnet', height: ARMED,     expected: true },
            { network: 'regtest', height: 1,         expected: true }
        ];
        for (const c of cases) {
            const sim = new ContractSimulator({ coin: 'BTC', network: c.network, block: { height: c.height } });
            const real = sim.vm.validateSyntax.bind(sim.vm);
            let flag;
            sim.vm.validateSyntax = (src, opts) => { flag = opts.enforceLintNestingDepth; return real(src, opts); };
            try {
                const verdict = sim.deployGateVerdict(NESTED);
                const label = c.network + '@' + c.height;
                assert.strictEqual(flag, c.expected, label + ' nesting flag');
                if (c.expected) {
                    assert.strictEqual(verdict.valid, false, label + ' must reject the nested source');
                    assert.match(String(verdict.error), /nesting depth/, label);
                } else {
                    assert.deepStrictEqual(verdict, { valid: true }, label + ' must accept, as the chain does');
                }
            } finally { sim.vm.validateSyntax = real; await sim.close(); }
        }
    });
});
