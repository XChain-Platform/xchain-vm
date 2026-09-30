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

describe('toolkit: simulator optional-chain deploy gate', function () {
    this.timeout(30000);

    it('passes the network activation verdict to validateSyntax', async function () {
        const cases = [
            { network: 'regtest', expected: true },
            { network: 'testnet', expected: false },
            { network: 'mainnet', expected: false }
        ];

        for (const testCase of cases) {
            const sim = new ContractSimulator({
                coin: 'BTC',
                network: testCase.network,
                block: { height: 10000000 }
            });
            const seen = [];
            const validateSyntax = sim.vm.validateSyntax;
            sim.vm.validateSyntax = function (src, opts) {
                seen.push(opts);
                return { valid: true };
            };

            try {
                assert.deepStrictEqual(
                    sim.deployGateVerdict('module.exports = function () {};'),
                    { valid: true }
                );
                assert.strictEqual(seen.length, 1);
                assert.strictEqual(
                    Object.prototype.hasOwnProperty.call(seen[0], 'enforceLintOptionalChain'),
                    true,
                    testCase.network + ' explicit option'
                );
                assert.strictEqual(
                    seen[0].enforceLintOptionalChain,
                    testCase.expected,
                    testCase.network + ' activation verdict'
                );
            } finally {
                sim.vm.validateSyntax = validateSyntax;
                await sim.close();
            }
        }
    });
});
