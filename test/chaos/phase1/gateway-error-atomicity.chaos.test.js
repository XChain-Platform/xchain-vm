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
 * Chaos Experiment 3: Gateway Error Atomicity
 *
 * Injects faults into oracle/crossChain accessors mid-execution to
 * verify that ALL preceding state changes and emissions are atomically
 * discarded when the gateway throws.
 *
 * NOTE: opts.state is consumed by StateManager's constructor as a
 * plain object, so we cannot intercept state.set() calls from outside.
 * Gateway fault injection works through oracleData/crossChainData
 * accessors, whose methods are called synchronously inside the bridge
 * closure in src/index.js.
 ********************************************************************/
// @ts-nocheck

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { XChainVM, createVM, execute, ProgrammableMock, chaosAssertions } = require('../helpers/harness');
const { ProgrammableOracleProvider, ProgrammableCrossChainProvider } = require('../helpers/programmable-mock');
const { checkResultShape, checkAtomicity } = require('../../fuzz/invariants');

const gatewayCallerCode = fs.readFileSync(
    path.join(__dirname, '..', 'contracts', 'gateway_caller.js'), 'utf8'
);

(XChainVM ? describe : describe.skip)('Chaos: Gateway Error Atomicity (Exp 3)', function() {

    let vm;
    before(function() { vm = createVM(); });

    it('CHAOS-301: oracle throw on 3rd call discards preceding state writes', async function() {
        const mock = new ProgrammableMock();
        mock.onCall(3).throw(new Error('chaos: oracle fault injected'));

        // Contract does 2 state writes, then 3 oracle reads (3rd throws)
        const result = await execute(vm, gatewayCallerCode, {
            params: ['2', '3'],
            oracleData: mock.asOracleData()
        });

        assert.strictEqual(result.success, false, 'Should fail on oracle throw');
        checkResultShape(result);
        // Atomicity: ALL state writes discarded
        assert.strictEqual(result.stateChanges.length, 0,
            'State changes must be discarded after oracle fault');
        assert.strictEqual(result.emittedActions.length, 0,
            'Emissions must be discarded after oracle fault');
        assert(result.gasUsed > 0, 'Gas should be charged before fault');
    });

    it('CHAOS-302: oracle throw on 1st call discards nothing (early abort)', async function() {
        const mock = new ProgrammableMock();
        mock.onCall(1).throw(new Error('chaos: immediate oracle fault'));

        const code = `module.exports = function(xchain) {
            xchain.oracle.getPrice('BTC/USD');
        };`;
        const result = await execute(vm, code, { oracleData: mock.asOracleData() });

        assert.strictEqual(result.success, false);
        checkAtomicity(result);
    });

    it('CHAOS-303: emissions queued before fault are discarded', async function() {
        const mock = new ProgrammableMock();
        // Oracle throws on the 2nd call
        mock.onCall(2).throw(new Error('chaos: oracle fault after emissions'));

        const code = `module.exports = function(xchain) {
            xchain.emit.send({ destination: 'addr1', tick: 'TEST', quantity: '100' });
            xchain.emit.send({ destination: 'addr2', tick: 'TEST', quantity: '200' });
            xchain.oracle.getPrice('BTC/USD');  // call 1 - ok
            xchain.oracle.getPrice('ETH/USD');  // call 2 - throws
            xchain.emit.send({ destination: 'addr3', tick: 'TEST', quantity: '300' });
        };`;

        const result = await execute(vm, code, { oracleData: mock.asOracleData() });

        assert.strictEqual(result.success, false);
        // Both emissions from before the fault must be discarded
        assert.strictEqual(result.emittedActions.length, 0,
            'All emissions must be discarded on mid-execution fault');
        assert.strictEqual(result.stateChanges.length, 0);
    });

    it('CHAOS-304: crossChain throw mid-execution discards all changes', async function() {
        const provider = new ProgrammableCrossChainProvider();
        provider.onMethodCall('getAttestation', 2)
            .throw(new Error('chaos: crossChain attestation fault'));

        const code = `module.exports = function(xchain) {
            xchain.state.set('a', '1');
            xchain.state.set('b', '2');
            xchain.emit.send({ destination: 'test', tick: 'T', quantity: '1' });
            xchain.crossChain.getAttestation('BTC', 0);  // call 1 - ok
            xchain.crossChain.getAttestation('LTC', 0);  // call 2 - throws
            xchain.state.set('c', '3');
        };`;

        const result = await execute(vm, code, {
            crossChainData: provider.asAccessor()
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stateChanges.length, 0, 'State discarded on crossChain fault');
        assert.strictEqual(result.emittedActions.length, 0, 'Emissions discarded on crossChain fault');
    });

    it('CHAOS-305: logs are preserved despite gateway fault', async function() {
        const mock = new ProgrammableMock();
        mock.onCall(1).throw(new Error('chaos: oracle fault'));

        const code = `module.exports = function(xchain) {
            xchain.log('before oracle call');
            xchain.state.set('x', 'y');
            xchain.oracle.getPrice('BTC/USD');  // throws
        };`;

        const result = await execute(vm, code, { oracleData: mock.asOracleData() });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stateChanges.length, 0);
        assert(result.logs.length > 0, 'Logs should be preserved on failure');
        assert(result.logs[0].includes('before oracle call'));
    });

    it('CHAOS-306: VM recovers after gateway fault', async function() {
        const mock = new ProgrammableMock();
        mock.onCall(1).throw(new Error('chaos: fault'));

        await execute(vm, `module.exports = function(xchain) {
            xchain.oracle.getPrice('BTC/USD');
        };`, { oracleData: mock.asOracleData() });

        // Recovery with normal oracle data
        await chaosAssertions.assertRecovery(vm);
    });

    it('CHAOS-307: null oracle return does not crash VM', async function() {
        const mock = new ProgrammableMock();
        mock.setDefault(null);

        const code = `module.exports = function(xchain) {
            var price = xchain.oracle.getPrice('BTC/USD');
            xchain.state.set('price', price === null ? 'null' : String(price));
            return price;
        };`;

        const result = await execute(vm, code, { oracleData: mock.asOracleData() });
        checkResultShape(result);
        // Should succeed: null is a valid oracle response
        assert.strictEqual(result.success, true, 'Null oracle return should not crash: ' + result.error);
    });
});
