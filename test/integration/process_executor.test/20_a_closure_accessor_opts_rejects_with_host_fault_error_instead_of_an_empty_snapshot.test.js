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
 * Out-of-process executor: a legacy closure accessor in the read-only data
 * opts works in process but the JSON worker channel would drop its functions
 * and hand the contract an empty snapshot. The subprocess path rejects it as a
 * host fault instead, so the two paths never return different results.
 ********************************************************************/
// @ts-nocheck

const { assert, makeVM, BASE, HAVE_IVM } = require('./support/executor_setup.js');
const { closureAccessorField } = require('../../../src/process_executor/opts_guard.js');

const CODE = `module.exports = function(xchain){ return xchain.oracle.getPrice('BTC/USD'); };`;
const closureOracle = () => ({
    getPrice: () => '65000.00', getPriceAtRound: () => null, getSnapshotAge: () => 3
});

describe('process_executor: closure accessor detection', function () {
    it('names the first read-only opt that exposes its accessor method as a function', function () {
        assert.strictEqual(closureAccessorField(null), null);
        assert.strictEqual(closureAccessorField({ oracleData: { prices: {}, snapshotAge: 1 } }), null);
        assert.strictEqual(closureAccessorField({ oracleData: new Map() }), null);
        assert.strictEqual(closureAccessorField({ oracleData: closureOracle() }), 'oracleData');
        assert.strictEqual(closureAccessorField({ pollData: { getPollResult: () => null } }), 'pollData');
        assert.strictEqual(closureAccessorField({ contractStakeData: { getStake: () => '0' } }), 'contractStakeData');
        assert.strictEqual(closureAccessorField({ crossChainData: { getAttestation: () => null } }), 'crossChainData');
        assert.strictEqual(closureAccessorField({ attestationData: { getResponse: () => null } }), 'attestationData');
    });
});

(HAVE_IVM ? describe : describe.skip)('process_executor: closure accessor opts', function () {
    this.timeout(60000);

    let vm;
    afterEach(async function () {
        if (vm) { await vm.shutdown(); vm = null; }
    });

    it('serves the closure in process, which is the result the worker channel must not change', async function () {
        vm = makeVM('in-process');
        vm.beginBlock();
        const r = await vm.execute({ ...BASE, code: CODE, oracleData: closureOracle() });
        assert.strictEqual(r.success, true, r.error);
        assert.strictEqual(r.returnValue, '"65000.00"');
    });

    it('rejects the same opts in the subprocess and keeps serving plain snapshots', async function () {
        vm = makeVM('subprocess');
        vm.beginBlock();
        await assert.rejects(vm.execute({ ...BASE, code: CODE, oracleData: closureOracle() }),
            (e) => e.name === 'HostFaultError' && /not serializable: oracleData is a closure accessor/.test(e.message));
        const plain = await vm.execute({
            ...BASE, code: CODE,
            oracleData: { snapshotAge: 3, prices: { 'BTC/USD': '65000.00' }, rounds: {} }
        });
        assert.strictEqual(plain.success, true, plain.error);
        assert.strictEqual(plain.returnValue, '"65000.00"');
    });
});
